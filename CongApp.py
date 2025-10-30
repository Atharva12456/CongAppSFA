import requests
import time
from typing import List, Dict
import json
import sys
import os

# Read API key strictly from environment variable
API_KEY = os.environ.get('SEMANTIC_SCHOLAR_API_KEY')

# Set up headers only if API key is present
headers = {"x-api-key": API_KEY} if API_KEY else {}
if not API_KEY:
    print("[WARN] SEMANTIC_SCHOLAR_API_KEY is not set; API requests may fail.", file=sys.stderr)

BASE = "https://api.semanticscholar.org/graph/v1"

def search_top_papers(query: str, k=10):
    """
    Search papers by keyword query, return top-k most relevant (by Semantic Scholar rank).
    """
    url = f"{BASE}/paper/search"
    params = {
        "query": query,
        "limit": k,
        "fields": "paperId,title,abstract,year,citationCount,authors,influentialCitationCount"
    }
    try:
        r = requests.get(url, params=params, headers=headers, timeout=30)
        if r.status_code == 200:
            data = r.json() or {}
            return data.get("data", []) or []
        else:
            r.raise_for_status()
    except Exception as e:
        print(f"[ERROR] search_top_papers failed: {e}", file=sys.stderr)
        return []


def get_recommendations(paper_id: str, limit: int = 10, fields: str = "paperId,title,year,citationCount,abstract,authors,influentialCitationCount"):
    """
    Fetch Semantic Scholar's recommendations for a paper (POST /recommendations).
    """
    url = f"{BASE}/recommendations"
    payload = {"paperId": paper_id, "fields": fields, "limit": limit}
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=20)
        if r.status_code == 200:
            data = r.json() or {}
            recs = data.get("recommendedPapers", []) or []
            return recs
        else:
            print(f"[WARN] Recommendations returned {r.status_code} for {paper_id}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] get_recommendations({paper_id}) failed: {e}", file=sys.stderr)
    return []


def _pretty_print_seed(seed: Dict, index: int):
    """
    Pretty-print a single seed paper to stderr.
    """
    title = seed.get("title", "Untitled")
    year = seed.get("year", "N/A")
    cites = seed.get("citationCount", 0)
    print(f"\n{index}. {title}", file=sys.stderr)
    print(f"   Year: {year}  Citations: {cites}", file=sys.stderr)
    pid = seed.get("paperId")
    if pid:
        print(f"   paperID: {pid}", file=sys.stderr)


def get_paper_details(paper_id: str):
    """
    GET /paper/{paperId} – return dict with paper fields.
    """
    fields = "paperId,title,year,abstract,citationCount,authors,venue,influentialCitationCount"
    url = f"{BASE}/paper/{paper_id}"
    params = {"fields": fields}
    try:
        r = requests.get(url, params=params, headers=headers, timeout=20)
        if r.status_code == 200:
            return r.json() or {}
    except Exception as e:
        print(f"[WARN] get_paper_details({paper_id}) failed: {e}", file=sys.stderr)
    return {}


def get_paper_references(paper_id: str, limit: int = 50):
    """
    GET /paper/{paperId}/references with pagination (up to `limit` total refs).
    Returns a list of reference dictionaries: [{'paperId':..., 'title':..., ...}, ...]
    """
    direct_url = f"{BASE}/paper/{paper_id}/references"
    fields = "paperId,title,year,citationCount,abstract,authors,venue,influentialCitationCount"
    params = {
        "fields": fields,
        "limit": min(limit, 1000),
        "offset": 0
    }
    refs = []
    try:
        while len(refs) < limit:
            r = requests.get(direct_url, params=params, headers=headers, timeout=20)
            if r.status_code == 200:
                data = r.json() or {}
                items = data.get("data", []) or []
                if not items:
                    break
                for item in items:
                    cp = item.get("citedPaper") or {}
                    refs.append(cp)
                    if len(refs) >= limit:
                        break
                nxt = data.get("next")
                if not nxt:
                    break
                params["offset"] = nxt
            else:
                break
        if refs:
            return refs[:limit]
        else:
            r.raise_for_status()
    except Exception as e:
        print(f"[WARN] get_paper_references({paper_id}) failed: {e}", file=sys.stderr)
    return []


def get_paper_citations(paper_id: str, limit: int = 50):
    """
    GET /paper/{paperId}/citations with pagination (up to `limit` total cites).
    Returns list: [{ 'paperId':..., 'title':..., ... }, ...]
    """
    direct_url = f"{BASE}/paper/{paper_id}/citations"
    fields = "paperId,title,year,citationCount,abstract,authors,venue,influentialCitationCount"
    params = {
        "fields": fields,
        "limit": min(limit, 1000),
        "offset": 0
    }
    cits = []
    try:
        while len(cits) < limit:
            r = requests.get(direct_url, params=params, headers=headers, timeout=20)
            if r.status_code == 200:
                data = r.json() or {}
                items = data.get("data", []) or []
                if not items:
                    break
                for item in items:
                    cp = item.get("citingPaper") or {}
                    cits.append(cp)
                    if len(cits) >= limit:
                        break
                nxt = data.get("next")
                if not nxt:
                    break
                params["offset"] = nxt
            else:
                break
        if cits:
            return cits[:limit]
        else:
            r.raise_for_status()
    except Exception as e:
        print(f"[WARN] get_paper_citations({paper_id}) failed: {e}", file=sys.stderr)
    return []


def get_recommendations_with_abstract(paper_id: str, limit: int = 20) -> List[Dict]:
    """
    Wrapper over your get_recommendations that ensures we also fetch abstracts for cosine similarity.
    """
    fields = "paperId,title,year,abstract,citationCount,authors,venue,influentialCitationCount"
    try:
        result = get_recommendations(paper_id, limit=limit, fields=fields)
        return result if result else []
    except Exception as e:
        print(f"[WARN] get_recommendations_with_abstract failed for paper {paper_id}: {e}", file=sys.stderr)
        return []



def find_top_papers_for_paper(
    paper: Dict,
    min_year: int = 2010,
    max_references: int = 50,
    max_citations: int = 50,
    max_similar: int = 20,
    top_k: int = 3,
    w_sim: float = 0.55,   # semantic (cosine) weight
    w_rec: float = 0.20,   # recency weight
    w_cit: float = 0.25    # citations weight (log-normalized)
) -> List[Dict]:
    """
    Given ONE input paper (must include paperId), find papers directly connected
    to it (references, citations, similar) and return top_k ranked by:
    - semantic similarity (cosine on title+abstract),
    - recency (exp decay),
    - citations (log-normalized).
    """
    import re
    from collections import Counter

    paper_id = paper.get("paperId")
    if not paper_id:
        print("[ERROR] Paper ID required for find_top_papers_for_paper", file=sys.stderr)
        return []

    print(f"[INFO] Gathering connected papers for '{paper.get('title','N/A')}'...", file=sys.stderr)
    
    # Gather candidate papers
    candidates = {}
    
    # References
    for ref in get_paper_references(paper_id, limit=max_references):
        rid = ref.get("paperId")
        if not rid:
            continue
        y = ref.get("year") or 0
        if y and y < min_year:
            continue
        if rid not in candidates:
            candidates[rid] = dict(ref)

    # Citations
    for cit in get_paper_citations(paper_id, limit=max_citations):
        cid = cit.get("paperId")
        if not cid:
            continue
        y = cit.get("year") or 0
        if y and y < min_year:
            continue
        if cid not in candidates:
            candidates[cid] = dict(cit)

    # Semantic Scholar's recommendations (similar papers)
    if max_similar and max_similar > 0:
        for s in get_recommendations_with_abstract(paper_id, limit=max_similar):
            sid2 = s.get("paperId")
            if not sid2:
                continue
            y = s.get("year") or 0
            if y and y < min_year:
                continue
            if sid2 not in candidates:
                candidates[sid2] = dict(s)

    if not candidates:
        print("[INFO] No connected papers found after filtering.", file=sys.stderr)
        # Fallback: keyword search using the paper's title and abstract
        query_title = paper.get("title") or ""
        query_abstract = paper.get("abstract") or ""
        query_text = (query_title + " " + query_abstract).strip() or query_title
        print(f"[FALLBACK] Using keyword search with query: '{query_text[:100]}...'", file=sys.stderr)
        # Fetch more papers for fallback to ensure we get valid results after filtering
        fallback_k = max(top_k * 5, 40)  # Get at least 40 or 5x top_k, whichever is larger
        seeds = search_top_papers(query_text, k=fallback_k)
        print(f"[FALLBACK] Found {len(seeds)} papers from keyword search", file=sys.stderr)
        for s in seeds:
            sid = s.get("paperId")
            # Skip the original paper itself
            if sid and sid != paper_id and sid not in candidates:
                candidates[sid] = dict(s)
        print(f"[FALLBACK] Added {len(candidates)} unique candidates from fallback", file=sys.stderr)
        if not candidates:
            print("[FALLBACK] No papers found even with keyword search fallback", file=sys.stderr)
            return []

    # Build query = anchor paper's title + abstract
    query_title = paper.get("title") or ""
    query_abstract = paper.get("abstract") or ""
    query_text = f"{query_title} {query_abstract}".strip()

    docs = [query_text]
    cand_list = list(candidates.values())
    for c in cand_list:
        t = c.get("title") or ""
        a = c.get("abstract") or ""
        docs.append(f"{t} {a}".strip())

    # Compute cosine similarity via TF-IDF
    sim_scores = []
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
        vec = TfidfVectorizer(max_features=20000, ngram_range=(1, 2))
        X = vec.fit_transform(docs)
        qv, D = X[0], X[1:]
        sim_scores = cosine_similarity(qv, D).ravel().tolist()
    except Exception:
        # light fallback
        from collections import Counter
        q_words = set(re.findall(r'\w+', query_text.lower()))
        for c in cand_list:
            c_text = f"{c.get('title','')} {c.get('abstract','')}".lower()
            c_words = set(re.findall(r'\w+', c_text))
            overlap = len(q_words & c_words)
            total = len(q_words | c_words)
            sim_scores.append(overlap / max(total, 1))

    # Attach similarity
    for i, c in enumerate(cand_list):
        c["similarity"] = sim_scores[i] if i < len(sim_scores) else 0.0

    # Recency score
    import math
    current_year = time.localtime().tm_year
    half_life = 3.0  # years
    for c in cand_list:
        y = c.get("year") or 0
        if y and y > 0:
            age = current_year - y
            c["recency"] = math.exp(-age / half_life)
        else:
            c["recency"] = 0.0

    # Citation score
    for c in cand_list:
        cites = c.get("citationCount") or 0
        c["citeScore"] = math.log(1 + cites)

    # Normalize
    def _norm(lst):
        if not lst:
            return lst
        mx = max(lst)
        mn = min(lst)
        rng = mx - mn if mx != mn else 1.0
        return [(x - mn) / rng for x in lst]

    sims = _norm([c["similarity"] for c in cand_list])
    recs = _norm([c["recency"] for c in cand_list])
    cits = _norm([c["citeScore"] for c in cand_list])

    for i, c in enumerate(cand_list):
        c["similarity"] = sims[i] if i < len(sims) else 0.0
        c["recency"] = recs[i] if i < len(recs) else 0.0
        c["citeScore"] = cits[i] if i < len(cits) else 0.0
        c["score"] = w_sim * c["similarity"] + w_rec * c["recency"] + w_cit * c["citeScore"]

    cand_list.sort(key=lambda x: x["score"], reverse=True)
    return cand_list[:top_k]


def _pretty_print_topk(anchor_title, results):
    print(f"\nTop {len(results)} connected papers for:")
    print(f"  {anchor_title}")
    for i, p in enumerate(results, 1):
        print(f"{i}. {p.get('title')} ({p.get('year','N/A')})")
        print(f"   score={p['score']:.4f}  sim={p['similarity']:.4f}  rec={p['recency']:.4f}  cites={p.get('citationCount',0)}")
        print(f"   paperId={p.get('paperId')}")

def is_valid_paper(paper):
    """
    Filter out invalid papers (metadata artifacts, incomplete entries, etc.)
    """
    title = paper.get("title", "").strip()
    
    # Check minimum title length - more lenient to allow shorter valid titles
    if len(title) < 5:
        return False
    
    # Filter out obvious non-papers (URLs, very specific patterns)
    invalid_patterns = [
        "doi:", "http://", "https://", "www.", 
        "github.com", "arxiv.org"
    ]
    title_lower = title.lower()
    if any(pattern in title_lower for pattern in invalid_patterns):
            return False
    
    # Filter out single word titles
    if len(title.split()) <= 1:
        return False
    
    # Year is optional; many API records omit it
    # if not paper.get("year"): return False
    
    return True

# Command-line interface for server integration
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Research paper analysis')
    parser.add_argument('--topic', type=str, help='Research topic to analyze')
    parser.add_argument('--paper-id', type=str, help='Paper ID to find related papers for')
    parser.add_argument('--title', type=str, help='Title of the paper (optional, for related papers)')
    parser.add_argument('--abstract', type=str, help='Abstract of the paper (optional, for related papers)')
    parser.add_argument('--exclude-ids', type=str, help='JSON array of paper IDs to exclude (to avoid duplicates)')
    parser.add_argument('--json', action='store_true', help='Output results as JSON to stdout')
    args = parser.parse_args()
    
    # Parse excluded paper IDs
    exclude_ids = set()
    if args.exclude_ids:
        try:
            exclude_ids = set(json.loads(args.exclude_ids))
            print(f"[INFO] Excluding {len(exclude_ids)} paper IDs to avoid duplicates", file=sys.stderr)
        except json.JSONDecodeError:
            print(f"[WARN] Failed to parse --exclude-ids, ignoring", file=sys.stderr)
    
    # Start total timer
    total_start = time.time()
    
    # MODE 1: Find related papers for a given paper
    if args.paper_id:
        print(f"\n[RELATED] Finding related papers for paper ID: {args.paper_id}\n", file=sys.stderr)
        
        # Build paper dict
        paper = {
            "paperId": args.paper_id,
            "title": args.title or "",
            "abstract": args.abstract or ""
        }
        
        # Time the search operation
        search_start = time.time()

        # Keep fetching more related papers until we have at least 2 valid ones
        valid_papers = []
        fetch_count = max(10, 2 + len(exclude_ids)) if exclude_ids else 10
        max_fetch = 300  # Try up to 300 papers
        
        # Always exclude the parent paper itself
        seen_ids = set(exclude_ids) if exclude_ids else set()
        seen_ids.add(args.paper_id)  # Ensure parent paper is never returned
        accumulated: List[Dict] = []
        while len(valid_papers) < 2 and fetch_count <= max_fetch:
            print(f"[SEARCH] Fetching top {fetch_count} related papers...", file=sys.stderr)
            related_papers = find_top_papers_for_paper(
                paper=paper,
                min_year=2000,         # relax recency
                max_references=100,    # fetch more references
                max_citations=100,     # fetch more citations
                max_similar=0,
                top_k=fetch_count
            )
            
            # Accumulate and deduplicate across attempts
            for p in related_papers:
                pid = p.get('paperId')
                if not pid or pid in seen_ids:
                    continue
                accumulated.append(p)
                seen_ids.add(pid)

            # Filter valid papers from accumulated pool
            valid_papers = [p for p in accumulated if is_valid_paper(p)]
            
            # Filter out excluded paper IDs (to avoid duplicates)
            if exclude_ids:
                before_count = len(valid_papers)
                valid_papers = [p for p in valid_papers if p.get('paperId') not in exclude_ids]
                filtered_count = before_count - len(valid_papers)
                if filtered_count > 0:
                    print(f"[INFO] Filtered out {filtered_count} duplicate papers", file=sys.stderr)
            
            if len(valid_papers) < 2 and fetch_count < max_fetch:
                print(f"[SEARCH] Only found {len(valid_papers)} valid papers, increasing search...", file=sys.stderr)
                fetch_count = min(fetch_count + 50, max_fetch)  # Increase by 50 each time
            else:
                break
        
        search_time = time.time() - search_start
        print(f"[TIME] Related papers search completed in {search_time:.2f} seconds", file=sys.stderr)
        
        print(f"\n[RESULTS] Found {len(valid_papers)} valid related papers", file=sys.stderr)
        for i, p in enumerate(valid_papers[:2], 1):
            print(f"{i}. {p.get('title')} ({p.get('year')}) — Citations: {p.get('citationCount', 0)}", file=sys.stderr)
        
        total_time = time.time() - total_start
        
        # Output JSON to stdout if requested
        if args.json:
            output = {
                "success": True,
                "paperId": args.paper_id,
                "papers": [
                    {
                        "title": p.get("title", "Untitled"),
                        "year": p.get("year", 0),
                        "citations": p.get("citationCount", 0),
                        "influentialCitations": p.get("influentialCitationCount", 0),
                        "authors": [a.get("name", "Unknown") for a in p.get("authors", [])],
                        "paperId": p.get("paperId", "")
                    }
                    for p in valid_papers[:2]  # Only return top 2
                ],
                "executionTime": round(total_time, 2)
            }
            print(json.dumps(output))
        else:
            # Manual run - show results in terminal
            print(f"\n[RELATED] Got {len(valid_papers)} related paper(s).")
            for idx, p in enumerate(valid_papers[:2], 1):
                _pretty_print_seed(p, idx)
    
   # MODE 2: Find papers by topic (original behavior)
    else:
        # Use provided topic or default
        topic = args.topic if args.topic else "climate change and urban migration modeling"
    
        print(f"\n[SEARCH] Finding seed papers for topic: {topic}\n", file=sys.stderr)
        
        # Time the search operation
        search_start = time.time()
        
        # Keep fetching more papers until we have at least 4 valid ones
        valid_papers = []
        fetch_count = 40
        max_fetch = 100  # Safety limit
        
        while len(valid_papers) < 4 and fetch_count <= max_fetch:
            print(f"[SEARCH] Fetching {fetch_count} papers...", file=sys.stderr)
            seed_papers = search_top_papers(topic, k=fetch_count)
            valid_papers = [p for p in seed_papers if is_valid_paper(p)]
            
            if len(valid_papers) < 4:
                print(f"[SEARCH] Only found {len(valid_papers)} valid papers, fetching more...", file=sys.stderr)
                fetch_count += 20  # Increase fetch count
            else:
                break
        
        search_time = time.time() - search_start
        print(f"[TIME] Search completed in {search_time:.2f} seconds", file=sys.stderr)

        print(f"\n[RESULTS] Found {len(valid_papers)} valid papers (showing top 4)", file=sys.stderr)
        for i, p in enumerate(valid_papers[:4], 1):
            print(f"{i}. {p.get('title')} ({p.get('year')}) — Citations: {p.get('citationCount', 0)}", file=sys.stderr)
            
    total_time = time.time() - total_start
    
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
                            "paperId": p.get("paperId", "")
                }
                        for p in valid_papers[:4]  # Return top 4
            ],
            "executionTime": round(total_time, 2)
        }
        print(json.dumps(output))

    else:
                # Manual run - show results in terminal
                print(f"\n[SEARCH] Got {len(valid_papers)} valid paper(s).")
                for idx, seed in enumerate(valid_papers[:4], 1):
                    _pretty_print_seed(seed, idx)
"""
if __name__ == "__main__":
    # Start total timer
    total_start = time.time()
    
    # Pick one example from your test set:
    topic = "machine learning in medical imaging"  # example query
    
    print(f"\n[SEARCH] Finding seed papers for topic: {topic}\n", file=sys.stderr)
    
    # Time the search operation
    search_start = time.time()
    seed_papers = search_top_papers(topic, k=10)
    search_time = time.time() - search_start
    print(f"[TIME] Search completed in {search_time:.2f} seconds", file=sys.stderr)
    
    # Display seed papers
    print(f"\n[SEARCH] Got {len(seed_papers)} seed paper(s).")
    for idx, seed in enumerate(seed_papers, 1):
        _pretty_print_seed(seed, idx)
    
    if not seed_papers:
        print("[ERROR] No seed papers found. Try a different query.")
        exit()
    
    # For demonstration, pick the top seed paper (index 0)
    anchor = seed_papers[0]
    print(f"\n[ANCHOR] Choosing anchor paper:")
    print(f"  {anchor.get('title')}")
    anchor_title = anchor.get("title")
    
    # Time the multi-level paper search
    multi_level_start = time.time()
    top_papers = find_top_papers_for_paper(anchor, top_k=3)
    multi_level_time = time.time() - multi_level_start
    print(f"\n[TIME] Multi-level search completed in {multi_level_time:.2f} seconds", file=sys.stderr)
    
    # Print top papers
    _pretty_print_topk(anchor_title, top_papers)
    
    # Total execution time
    total_time = time.time() - total_start
    print(f"\n[TIME] Total execution time: {total_time:.2f} seconds", file=sys.stderr)
"""
