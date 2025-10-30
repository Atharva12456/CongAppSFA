import math
import requests
import time
from collections import defaultdict
from typing import List, Dict
from sentence_transformers import SentenceTransformer, util

# Optional: put your Semantic Scholar API key here
API_KEY = None  # or None if unauthenticated

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
        print("No papers found for topic:", topic)
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

# ---------- ADD THESE HELPERS (standalone, no self) ----------

def get_paper_references(paper_id: str, limit: int = 100) -> List[Dict]:
    """
    References (papers this paper cites). Falls back to pulling
    references from the main paper endpoint if /references is forbidden.
    """
    direct_url = f"{GRAPH_URL}{paper_id}/references"
    params = {
        "fields": "paperId,title,year,abstract,citationCount,authors,venue,influentialCitationCount",
        "limit": limit
    }
    try:
        r = requests.get(direct_url, params=params, headers=headers, timeout=20)
        if r.status_code == 200:
            data = r.json() or {}
            items = data.get("data", []) or []
            return [it.get("citedPaper", {}) for it in items if it.get("citedPaper")]
        elif r.status_code == 403:
            fb_url = f"{GRAPH_URL}{paper_id}"
            fb_params = {
                "fields": (
                    "references.paperId,references.title,references.year,"
                    "references.abstract,references.citationCount,"
                    "references.influentialCitationCount,references.venue,references.authors"
                )
            }
            data = requests.get(fb_url, params=fb_params, headers=headers, timeout=20).json() or {}
            refs = data.get("references", []) or []
            return refs[:limit]
        else:
            r.raise_for_status()
    except Exception as e:
        print(f"[WARN] get_paper_references({paper_id}) failed: {e}")
    return []


def get_paper_citations(paper_id: str, limit: int = 100) -> List[Dict]:
    """
    Citations (papers that cite this paper). Falls back to pulling
    citations from the main paper endpoint if /citations is forbidden.
    """
    direct_url = f"{GRAPH_URL}{paper_id}/citations"
    params = {
        "fields": "paperId,title,year,abstract,citationCount,authors,venue,influentialCitationCount",
        "limit": limit
    }
    try:
        r = requests.get(direct_url, params=params, headers=headers, timeout=20)
        if r.status_code == 200:
            data = r.json() or {}
            items = data.get("data", []) or []
            return [it.get("citingPaper", {}) for it in items if it.get("citingPaper")]
        elif r.status_code == 403:
            fb_url = f"{GRAPH_URL}{paper_id}"
            fb_params = {
                "fields": (
                    "citations.paperId,citations.title,citations.year,"
                    "citations.abstract,citations.citationCount,"
                    "citations.influentialCitationCount,citations.venue,citations.authors"
                )
            }
            data = requests.get(fb_url, params=fb_params, headers=headers, timeout=20).json() or {}
            cits = data.get("citations", []) or []
            return cits[:limit]
        else:
            r.raise_for_status()
    except Exception as e:
        print(f"[WARN] get_paper_citations({paper_id}) failed: {e}")
    return []


def get_recommendations_with_abstract(paper_id: str, limit: int = 20) -> List[Dict]:
    """
    Wrapper over your get_recommendations that ensures we also fetch abstracts for cosine similarity.
    """
    fields = "paperId,title,year,abstract,citationCount,authors,venue,influentialCitationCount"
    try:
        return get_recommendations(paper_id, limit=limit, fields=fields) or []
    except Exception as e:
        print(f"[WARN] get_recommendations_with_abstract({paper_id}) failed: {e}")
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

    def _tok(s: str):
        return re.findall(r"[a-z0-9]+", (s or "").lower())

    def _cos_counts(cq: Counter, cd: Counter) -> float:
        if not cq or not cd: return 0.0
        dot = sum(cq[t] * cd.get(t, 0) for t in cq)
        nu = math.sqrt(sum(v * v for v in cq.values()))
        nv = math.sqrt(sum(v * v for v in cd.values()))
        return 0.0 if (nu == 0 or nv == 0) else dot / (nu * nv)

    def _text(p: Dict) -> str:
        return ((p.get("title") or "") + ". " + (p.get("abstract") or "")).strip()

    # Validate input
    paper_id = paper.get("paperId")
    if not paper_id:
        print("Error: input paper must have 'paperId'")
        return []

    query_text = _text(paper)
    now_year = time.localtime().tm_year

    # Collect one-hop candidates
    candidates: Dict[str, Dict] = {}

    # references
    for r in get_paper_references(paper_id, limit=max_references):
        rid = r.get("paperId")
        if not rid: continue
        y = r.get("year") or 0
        if y and y < min_year: continue
        if rid not in candidates:
            # add minimal metrics
            candidates[rid] = dict(r)

    # citations
    for c in get_paper_citations(paper_id, limit=max_citations):
        cid = c.get("paperId")
        if not cid: continue
        y = c.get("year") or 0
        if y and y < min_year: continue
        if cid not in candidates:
            candidates[cid] = dict(c)

    # similar
    for s in get_recommendations_with_abstract(paper_id, limit=max_similar):
        sid2 = s.get("paperId")
        if not sid2: continue
        y = s.get("year") or 0
        if y and y < min_year: continue
        if sid2 not in candidates:
            candidates[sid2] = dict(s)

    if not candidates:
        print("[INFO] No connected papers found after filtering.")
        return []

    # Build corpus [query, cand...]
    ids = list(candidates.keys())
    docs = [query_text] + [_text(candidates[i]) for i in ids]

    # Cosine similarity: prefer TF-IDF (no heavy deps); fallback to token cosine
    sim_scores = None
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
        q_counts = Counter(_tok(query_text))
        sim_scores = [_cos_counts(q_counts, Counter(_tok(d))) for d in docs[1:]]

    # Normalize sim to [0,1]
    smin, smax = (min(sim_scores), max(sim_scores)) if sim_scores else (0.0, 1.0)
    if smax - smin > 1e-12:
        sims_norm = [(s - smin) / (smax - smin) for s in sim_scores]
    else:
        sims_norm = [0.0] * len(sim_scores)

    # Recency + citations features
    raw_cits = [int(candidates[i].get("citationCount", 0) or 0) for i in ids]
    log_cits = [math.log1p(c) for c in raw_cits]
    cmin, cmax = (min(log_cits) if log_cits else 0.0), (max(log_cits) if log_cits else 1.0)
    cspan = (cmax - cmin) or 1.0

    results = []
    for idx, pid in enumerate(ids):
        p = candidates[pid]
        y = p.get("year") or 0
        rec = math.exp(-(now_year - y) / 5.0) if y else 0.0
        citn = (math.log1p(p.get("citationCount", 0) or 0) - cmin) / cspan

        score = (w_sim * sims_norm[idx]) + (w_rec * rec) + (w_cit * citn)

        out = dict(p)
        out["paperId"] = pid
        out["similarity"] = round(sims_norm[idx], 4)
        out["recency"] = round(rec, 4)
        out["citations_norm"] = round(citn, 4)
        out["score"] = round(float(score), 6)
        results.append(out)

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]

def _pretty_print_seed(seed, idx):
    print(f"\n=== SEED {idx} ===")
    print(f"Title : {seed.get('title')}")
    print(f"Year  : {seed.get('year')}")
    print(f"Cites : {seed.get('citationCount', 0)}")
    print(f"ID    : {seed.get('paperId')}")


def _pretty_print_topk(anchor_title, results):
    print(f"\nTop {len(results)} connected papers for:")
    print(f"  {anchor_title}")
    for i, p in enumerate(results, 1):
        print(f"{i}. {p.get('title')} ({p.get('year','N/A')})")
        print(f"   score={p['score']:.4f}  sim={p['similarity']:.4f}  rec={p['recency']:.4f}  cites={p.get('citationCount',0)}")
        print(f"   paperId={p.get('paperId')}")

# Command-line interface for server integration
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Research paper analysis')
    parser.add_argument('--topic', type=str, help='Research topic to analyze')
    parser.add_argument('--json', action='store_true', help='Output results as JSON to stdout')
    args = parser.parse_args()
    
    # Use provided topic or default
    topic = args.topic if args.topic else "climate change and urban migration modeling"
    
    # Start total timer
    total_start = time.time()
    
    print(f"\n[SEARCH] Finding seed papers for topic: {topic}\n", file=sys.stderr)
    
    # Time the search operation
    search_start = time.time()
    seed_papers = search_top_papers(topic, k=10)  # Get more papers to have choices after filtering
    search_time = time.time() - search_start
    print(f"[TIME] Search completed in {search_time:.2f} seconds", file=sys.stderr)
    
    # Filter valid papers
    valid_papers = [p for p in seed_papers if is_valid_paper(p)]
    
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
                for p in valid_papers[:4]  # Only return top 4
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

    topic = "effect of surrounding environment on human behavior"
    print(f"\n[SEARCH] Finding seed papers for topic: {topic}\n")

    # Time the search operation
    search_start = time.time()
    seed_papers = search_top_papers(topic, k=5)
    search_time = time.time() - search_start
    print(f"[TIME] Search completed in {search_time:.2f} seconds")

    print("\n[SEEDS] Seed Papers:")
    for i, p in enumerate(seed_papers, 1):
        print(f"{i}. {p['title']} ({p['year']}) — Citations: {p['citationCount']}")

    print("\n[NETWORK] Building network...")
    network_start = time.time()
    # No limit - analyze full network (will take longer but more comprehensive)
    top_network_papers = find_top_papers_multi_level(
        seed_papers,
        max_refs_per_paper=25,  # Back to default
        max_total_papers=None  # No limit
    )
    network_time = time.time() - network_start
    print(f"\n[TIME] Network analysis completed in {network_time:.2f} seconds")

    # Calculate and display total time
    total_time = time.time() - total_start
    print(f"\n{'=' * 60}")
    print(f"[TIME] TOTAL EXECUTION TIME: {total_time:.2f} seconds ({total_time / 60:.2f} minutes)")
    print(f"{'=' * 60}")
    print(f"  [BREAKDOWN] Time Analysis:")
    print(f"     - Paper search: {search_time:.2f}s ({search_time / total_time * 100:.1f}%)")
    print(f"     - Network analysis: {network_time:.2f}s ({network_time / total_time * 100:.1f}%)")
    print(f"{'=' * 60}")
"""
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