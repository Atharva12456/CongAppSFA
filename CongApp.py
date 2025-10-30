import math
import requests
import time
import json
import sys
import argparse
from collections import defaultdict
from typing import List, Dict
from sentence_transformers import SentenceTransformer, util

# Optional: put your Semantic Scholar API key here
API_KEY = None # or None if unauthenticated

# Base URLs for APIs
BASE_URL = "https://api.semanticscholar.org/graph/v1"
RECOMMEND_URL = "https://api.semanticscholar.org/recommendations/v1/papers/forpaper/"
GRAPH_URL = "https://api.semanticscholar.org/graph/v1/paper/"
SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"

# Add headers if you have an API key
headers = {"x-api-key": "XcsKxF9OmO6fbLVAVTFTx9wemVW2AYrU8vfZXBvp"}

def get_recommendations(paper_id, limit=10, fields=None):
    """
    Get recommended papers for a given Semantic Scholar paper ID.
    """
    params = {
        "limit": limit,
        "fields": fields or "title,year,url,authors,citationCount"
    }
    url = f"{RECOMMEND_URL}{paper_id}"
    res = requests.get(url, params=params, headers=headers)
    res.raise_for_status()
    data = res.json()
    return data.get("recommendedPapers", [])

def get_metadata(paper_id, fields=None):
    """
    Retrieve metadata for a single paper via the Graph API.
    """
    params = {
        "fields": fields or "title,year,abstract,venue,authors,citationCount,referenceCount"
    }
    url = f"{GRAPH_URL}{paper_id}"
    res = requests.get(url, params=params, headers=headers)
    res.raise_for_status()
    return res.json()

def is_valid_paper(paper):
    """
    Filter out invalid papers (metadata artifacts, incomplete entries, etc.)
    """
    title = paper.get("title", "").strip()
    
    # Check minimum title length
    if len(title) < 15:
        return False
    
    # Filter out common non-paper terms
    invalid_terms = [
        "arxiv", "et al", "abstract", "preprint",
        "doi:", "http:", "www.", "github", "repository",
        "dataset", "software", "code repository"
    ]
    title_lower = title.lower()
    if any(term in title_lower for term in invalid_terms):
        # Exception: if it's a longer descriptive title, it might be valid
        if len(title) < 30:
            return False
    
    # Filter out single letters or very short phrases
    if len(title.split()) <= 2:
        return False
    
    # Must have year
    if not paper.get("year"):
        return False
    
    return True

def search_top_papers(topic, k, recency_weight=0.3, citation_weight=0.2, relevance_weight=0.5):
    """
    Find the top-k most relevant papers for a given topic,
    scoring them based on recency, relevance, and citation count.
    """
    params = {
        "query": topic,
        "limit": 100,  # fetch more to score properly
        "fields": "paperId,title,year,abstract,citationCount,url"
    }

    res = requests.get(SEARCH_URL, params=params, headers=headers)
    res.raise_for_status()
    papers = res.json().get("data", [])

    if not papers:
        print("No papers found for topic:", topic, file=sys.stderr)
        return []
    
    # Filter out invalid papers
    papers = [p for p in papers if is_valid_paper(p)]
    
    if not papers:
        print("No valid papers found after filtering for topic:", topic, file=sys.stderr)
        return []

    current_year = time.localtime().tm_year
    scored_papers = []

    max_citations = max((p.get("citationCount", 0) for p in papers), default=1)
    max_relevance = max((p.get("relevanceScore", 1.0) for p in papers), default=1)

    for p in papers:
        year = p.get("year") or 2000
        citations = p.get("citationCount", 0)
        relevance = p.get("relevanceScore", 1.0)

        norm_recency = math.exp(-(current_year - year) / 5.0)
        norm_citations = citations / max_citations
        norm_relevance = relevance / max_relevance

        total_score = (
            recency_weight * norm_recency
            + citation_weight * norm_citations
            + relevance_weight * norm_relevance
        )

        scored_papers.append({
            "paperId": p["paperId"],
            "title": p.get("title"),
            "year": year,
            "citationCount": citations,
            "relevance": relevance,
            "url": p.get("url"),
            "score": total_score
        })

    top_papers = sorted(scored_papers, key=lambda x: x["score"], reverse=True)[:k]
    return top_papers


def find_top_papers_multi_level(seed_papers, depth=2, min_year=2010, max_refs_per_paper=25, max_total_papers=None):
    all_papers = {}
    citation_matrix = defaultdict(set)
    current_level = {p['paperId']: p for p in seed_papers if p.get('paperId')}

    for level in range(1, depth + 1):
        level_start = time.time()
        print(f"Level {level} — exploring {len(current_level)} papers", file=sys.stderr)
        next_level = {}

        for pid, paper in current_level.items():
            # Check if we've reached the paper limit
            if max_total_papers and len(all_papers) >= max_total_papers:
                print(f"  [LIMIT] Reached maximum paper limit ({max_total_papers}), stopping early", file=sys.stderr)
                break
                
            title = paper.get('title', 'Unknown')
            print(f"  Getting references for: {title[:60]}", file=sys.stderr)

            ref_url = f"{BASE_URL}/paper/{pid}/references?fields=paperId,title,year,citationCount,influentialCitationCount,authors"
            try:
                res = requests.get(ref_url, headers=headers)
                res.raise_for_status()
                json_data = res.json()
                refs = json_data.get("data", []) if isinstance(json_data, dict) else []
            except Exception as e:
                print(f"[WARNING] Failed to fetch refs for {pid}: {e}", file=sys.stderr)
                continue

            if not refs:
                print(f"   [WARNING] No references found for {pid}", file=sys.stderr)
                continue

            for r in refs[:max_refs_per_paper]:
                ref = r.get("citedPaper", {})
                ref_id = ref.get("paperId")
                if not ref_id:
                    continue

                ref_year = ref.get("year")
                # Skip papers without a year or before minimum year
                if ref_year is None or ref_year < min_year:
                    continue

                if ref_id not in all_papers:
                    all_papers[ref_id] = ref

                citation_matrix[ref_id].add(pid)
                if level < depth:
                    next_level[ref_id] = ref

            time.sleep(0.1)

        current_level = next_level
        level_time = time.time() - level_start
        print(f"  [TIME] Level {level} completed in {level_time:.2f} seconds", file=sys.stderr)
        
        # Exit early if we've reached the limit
        if max_total_papers and len(all_papers) >= max_total_papers:
            print(f"  [LIMIT] Paper limit reached, skipping remaining levels", file=sys.stderr)
            break

    print(f"\nTotal unique papers found: {len(all_papers)}", file=sys.stderr)

    # Time the scoring operation
    scoring_start = time.time()
    scored = []
    for pid, paper in all_papers.items():
        convergence = len(citation_matrix[pid])
        citations = paper.get("citationCount", 0)
        influential = paper.get("influentialCitationCount", 0)

        score = (
            convergence * 150
            + citations * 0.3
            + influential * 3.0
        )

        paper["matrix_score"] = round(score, 2)
        paper["convergence_count"] = convergence
        scored.append(paper)

    # Filter out invalid papers before final ranking
    scored = [p for p in scored if is_valid_paper(p)]
    
    # Get top 4 valid papers
    top = sorted(scored, key=lambda x: x["matrix_score"], reverse=True)[:4]
    scoring_time = time.time() - scoring_start
    print(f"[TIME] Scoring and ranking completed in {scoring_time:.2f} seconds", file=sys.stderr)

    print("\n[RESULTS] Top Papers in Network:", file=sys.stderr)
    for i, p in enumerate(top, 1):
        print(f"\n{i}. {p.get('title')}", file=sys.stderr)
        print(f"   Year: {p.get('year')}", file=sys.stderr)
        print(f"   Matrix Score: {p['matrix_score']}", file=sys.stderr)
        print(f"   Convergence: {p['convergence_count']}", file=sys.stderr)
        print(f"   Citations: {p.get('citationCount', 0)}", file=sys.stderr)

    return top

if __name__ == "__main__":
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='Research paper network analysis')
    parser.add_argument('--topic', type=str, help='Research topic to analyze')
    parser.add_argument('--json', action='store_true', help='Output results as JSON to stdout')
    args = parser.parse_args()
    
    # Use provided topic or default
    topic = args.topic if args.topic else "effect of surrounding environment on human behavior"
    
    # Start total timer
    total_start = time.time()
    
    print(f"\n[SEARCH] Finding seed papers for topic: {topic}\n", file=sys.stderr)
    
    # Time the search operation
    search_start = time.time()
    seed_papers = search_top_papers(topic, k=5)
    search_time = time.time() - search_start
    print(f"[TIME] Search completed in {search_time:.2f} seconds", file=sys.stderr)

    print("\n[SEEDS] Seed Papers:", file=sys.stderr)
    for i, p in enumerate(seed_papers, 1):
        print(f"{i}. {p['title']} ({p['year']}) — Citations: {p['citationCount']}", file=sys.stderr)

    print("\n[NETWORK] Building network...", file=sys.stderr)
    network_start = time.time()
    # No limit - analyze full network (will take longer but more comprehensive)
    top_network_papers = find_top_papers_multi_level(
        seed_papers, 
        max_refs_per_paper=25,  # Back to default
        max_total_papers=None   # No limit
    )
    network_time = time.time() - network_start
    print(f"\n[TIME] Network analysis completed in {network_time:.2f} seconds", file=sys.stderr)
    
    # Calculate and display total time
    total_time = time.time() - total_start
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"[TIME] TOTAL EXECUTION TIME: {total_time:.2f} seconds ({total_time/60:.2f} minutes)", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)
    print(f"  [BREAKDOWN] Time Analysis:", file=sys.stderr)
    print(f"     - Paper search: {search_time:.2f}s ({search_time/total_time*100:.1f}%)", file=sys.stderr)
    print(f"     - Network analysis: {network_time:.2f}s ({network_time/total_time*100:.1f}%)", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)
    
    # Output JSON to stdout if requested
    if args.json:
        output = {
            "success": True,
            "topic": topic,
            "papers": [
                {
                    "title": p.get("title", "Untitled"),
                    "year": p.get("year", 0),
                    "citations": p.get("citationCount", 0),
                    "influentialCitations": p.get("influentialCitationCount", 0),
                    "authors": [a.get("name", "Unknown") for a in p.get("authors", [])],
                    "paperId": p.get("paperId", ""),
                    "matrixScore": p.get("matrix_score", 0),
                    "convergence": p.get("convergence_count", 0)
                }
                for p in top_network_papers
            ],
            "executionTime": round(total_time, 2)
        }
        print(json.dumps(output))
    else:
        # Keep backward compatibility - show results in stderr for manual runs
        pass


"""
if __name__ == "__main__":
    seed_paper = "a3e4ceb42cbcd2c807d53aff90a8cb1f5ee3f031"  # sample ID
    metadata = get_metadata(seed_paper)

    # Print some key fields
    print("Title:", metadata.get("title"))
    print("Year:", metadata.get("year"))
    print("Venue:", metadata.get("venue"))
    print("Citation count:", metadata.get("citationCount"))
    print("Authors:", [a['name'] for a in metadata.get("authors", [])])
"""