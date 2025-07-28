import requests
import pandas as pd
from sentence_transformers import SentenceTransformer, util
from urllib.parse import quote
import argparse
import warnings

# Suppress the specific PyTorch deprecation warning about encoder_attention_mask
# This is a known compatibility issue between transformers and PyTorch versions
warnings.filterwarnings("ignore", category=FutureWarning, message=".*encoder_attention_mask.*")

# Initialize the embedding model
model = SentenceTransformer('all-MiniLM-L6-v2')

# =================================================================================
# Helper functions for searching and ranking names
# =================================================================================

def get_ranked_entities(search_term, top_n=5):
    """
    Get suggested entity names via autocompletions and rank them by semantic similarity.
    """
    if not search_term or not str(search_term).strip():
        # Empty search term – return empty DataFrame to avoid 400 error
        return pd.DataFrame({'entity': [], 'lei': [], 'score': []})

    encoded = quote(search_term)
    url = f"https://api.gleif.org/api/v1/autocompletions?field=fulltext&q={encoded}"
    try:
        resp = requests.get(url, headers={'Accept': 'application/vnd.api+json'})
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"Error fetching suggestions: {e}")
        return pd.DataFrame()

    entities = [item['attributes']['value'] for item in data.get('data', [])]
    if not entities:
        return pd.DataFrame({'entity': [], 'lei': [], 'score': []})

    df = pd.DataFrame({'entity': entities})

    search_emb = model.encode(search_term, convert_to_tensor=True)
    entity_embs = model.encode(df['entity'].tolist(), convert_to_tensor=True)
    scores = util.cos_sim(search_emb, entity_embs)[0].tolist()
    df['score'] = scores
    df_sorted = df.sort_values('score', ascending=False).head(top_n)

    # fetch LEI codes
    leis = []
    for name in df_sorted['entity']:
        leis.append(get_lei_for_entity_simple(name))
    df_sorted['lei'] = leis
    return df_sorted

def get_lei_for_entity_simple(entity_name):
    """Return the LEI code for an entity using fuzzycompletions."""
    try:
        encoded = quote(entity_name)
        url = f"https://api.gleif.org/api/v1/fuzzycompletions?field=fulltext&q={encoded}"
        resp = requests.get(url, headers={'Accept': 'application/vnd.api+json'})
        resp.raise_for_status()
        data = resp.json()
        if data.get('data'):
            for item in data['data']:
                if 'relationships' in item and 'lei-records' in item['relationships']:
                    company = item['attributes']['value']
                    lei_id = item['relationships']['lei-records']['data']['id']
                    if (
                        entity_name.lower() in company.lower()
                        or company.lower() in entity_name.lower()
                    ):
                        return lei_id
            for item in data['data']:
                if 'relationships' in item and 'lei-records' in item['relationships']:
                    return item['relationships']['lei-records']['data']['id']
    except Exception as e:
        print(f"Error fetching LEI for {entity_name}: {e}")
    return "LEI_NOT_FOUND"

# =================================================================================
# Functions for traversing hierarchy
# =================================================================================

def get_direct_children(lei):
    """
    Fetch direct children of a given LEI, with a large page size.
    """
    url = f"https://api.gleif.org/api/v1/lei-records/{lei}/direct-children?page[size]=200"
    children = []
    while url:
        resp = requests.get(url, headers={'Accept': 'application/vnd.api+json'})
        resp.raise_for_status()
        data = resp.json()
        for item in data.get('data', []):
            child_lei = item['attributes']['lei']
            child_name = item['attributes']['entity']['legalName']['name']
            children.append({'lei': child_lei, 'name': child_name})
        url = data.get('links', {}).get('next')
    return children

def get_ultimate_children(lei):
    """
    Fetch all ultimate (lowest-level) children for a parent LEI.
    """
    url = f"https://api.gleif.org/api/v1/lei-records/{lei}/ultimate-children?page[size]=200"
    resp = requests.get(url, headers={'Accept': 'application/vnd.api+json'})
    resp.raise_for_status()
    data = resp.json()
    return [
        {'lei': item['attributes']['lei'],
         'name': item['attributes']['entity']['legalName']['name']}
        for item in data.get('data', [])
    ]

def get_direct_parent(lei):
    """
    Fetch the direct parent of a given LEI. Returns None if no parent is reported.
    """
    url = f"https://api.gleif.org/api/v1/lei-records/{lei}/direct-parent"
    resp = requests.get(url, headers={'Accept': 'application/vnd.api+json'})
    if resp.status_code == 404:
        return None  # no direct parent
    resp.raise_for_status()
    data = resp.json()
    return {
        'lei': data['data']['attributes']['lei'],
        'name': data['data']['attributes']['entity']['legalName']['name']
    }

def get_ultimate_parent(lei):
    """
    Find the ultimate parent by following the parent chain upward.
    Returns the LEI of the ultimate parent (could be the same LEI if no parent exists).
    """
    current_lei = lei
    visited = set()
    
    while current_lei and current_lei not in visited:
        visited.add(current_lei)
        parent = get_direct_parent(current_lei)
        if parent:
            current_lei = parent['lei']
        else:
            # No parent found, this is the ultimate parent
            break
    
    return current_lei

def build_hierarchy(start_lei):
    """
    Build a hierarchical tree starting from the ultimate parent of the given LEI.
    Always shows the complete corporate structure from the top down.
    Returns a nested dict: {'lei': str, 'name': str, 'children': [subtrees...], 'original_search_lei': str}.
    """
    # First, find the ultimate parent
    ultimate_parent_lei = get_ultimate_parent(start_lei)
    
    visited = set()

    def recurse(lei, depth=0):
        if lei in visited:
            return None
        visited.add(lei)
        
        node_name = lei  # fallback
        spid = 'N/A'  # default S&P Global ID
        # get the entity name for the current LEI
        detail = get_entity_details(lei)
        if detail:
            node_name = detail['attributes']['entity']['legalName']['name']
            # Extract S&P Global Market Intelligence ID if available
            spglobal_array = detail['attributes'].get('spglobal', [])
            if spglobal_array and len(spglobal_array) > 0:
                spid = spglobal_array[0]
        
        country_code = detail['attributes']['entity']['headquartersAddress']['country'] if detail else 'N/A'
        node = {'lei': lei, 'name': node_name, 'spid': spid, 'country': country_code, 'children': []}
        
        # Get direct children
        children = get_direct_children(lei)
        if children:
            for child in children:
                child_node = recurse(child['lei'], depth + 1)
                if child_node:
                    node['children'].append(child_node)
        
        return node

    # Build initial tree via direct children starting from ultimate parent
    root = recurse(ultimate_parent_lei)
    
    # Store the original search LEI in the root for highlighting purposes
    root['original_search_lei'] = start_lei

    # Collect all LEIs present in the tree
    def collect_leis(subtree):
        leis = {subtree['lei']}
        for c in subtree['children']:
            leis.update(collect_leis(c))
        return leis

    existing_leis = collect_leis(root)

    # Fetch ultimate children and find those missing from the tree
    try:
        ultimate = get_ultimate_children(ultimate_parent_lei)
        missing = [child for child in ultimate if child['lei'] not in existing_leis]
        
        if missing:
            # Attach missing children either under their direct parent (if known) or at root
            for child in missing:
                parent_info = get_direct_parent(child['lei'])
                attached = False
                
                if parent_info and parent_info['lei'] != ultimate_parent_lei:
                    # try to attach to the direct parent if it's in the tree
                    def attach_to_parent(subtree):
                        nonlocal attached
                        if subtree['lei'] == parent_info['lei']:
                            subtree['children'].append({'lei': child['lei'], 'name': child['name'], 'spid': 'N/A', 'country': 'N/A', 'children': []})
                            attached = True
                            return True
                        for sub in subtree['children']:
                            if attach_to_parent(sub):
                                return True
                        return False
                    
                    if attach_to_parent(root):
                        continue
                
                # otherwise attach to the root node
                root['children'].append({'lei': child['lei'], 'name': child['name'], 'spid': 'N/A', 'country': 'N/A', 'children': []})
            
    except Exception:
        # Silently handle ultimate children fetch errors
        pass
    
    return root

def get_entity_details(lei):
    """
    Get detailed entity information by LEI.
    """
    try:
        url = f"https://api.gleif.org/api/v1/lei-records/{lei}"
        resp = requests.get(url, headers={'Accept': 'application/vnd.api+json'})
        resp.raise_for_status()
        return resp.json().get('data')
    except Exception:
        return None

def print_tree(node, indent=0, original_search_lei=None):
    """
    Nicely print a hierarchical tree of LEIs with color highlighting.
    Ultimate parent in red, searched entity in green.
    """
    # ANSI color codes
    RED = '\033[91m'    # Red for ultimate parent
    GREEN = '\033[92m'  # Green for searched entity
    RESET = '\033[0m'   # Reset to default color
    
    # Get the original search LEI from root node if not passed
    if original_search_lei is None and 'original_search_lei' in node:
        original_search_lei = node['original_search_lei']
    
    prefix = "    " * indent
    lei_info = f"({node['lei']}, S&P: {node.get('spid', 'N/A')})"
    
    if indent == 0:
        # Root level - ultimate parent in red text
        print(f"{RED}ULTIMATE PARENT: {node['name']} {lei_info}{RESET}")
    else:
        # Check if this is the searched entity
        if node['lei'] == original_search_lei:
            # Searched entity in green text
            print(f"{prefix}├── {GREEN}{node['name']} {lei_info}{RESET}")
        else:
            # Regular child
            print(f"{prefix}├── {node['name']} {lei_info}")
    
    for child in node['children']:
        print_tree(child, indent + 1, original_search_lei)

# =================================================================================
# Functions for interactive hierarchy display
# =================================================================================

def create_comparison_table(search_terms, top_n=5):
    """
    Create a comparison table for multiple search terms.
    """
    comparison_data = {}
    for term in search_terms:
        try:
            df = get_ranked_entities(term, top_n=top_n)
            comparison_data[term] = df['entity'].tolist() if not df.empty else []
        except Exception as e:
            print(f"Error processing {term}: {e}")
            comparison_data[term] = []
    
    return pd.DataFrame(comparison_data)

def display_matches(search_term, df):
    """
    Display search matches in a formatted way.
    """
    if df.empty:
        print(f"No matches found for '{search_term}'")
        return
    
    print(f"\nTop matches for '{search_term}':")
    print("=" * 60)
    for idx, row in df.iterrows():
        print(f"{idx + 1}. {row['entity']}")
        print(f"   LEI: {row['lei']}")
        print(f"   Score: {row['score']:.3f}")
        print()

def get_hierarchy_for_selection(search_terms, column_name, match_number):
    """
    Get and display hierarchy for a selected match from search results.
    This function is used by the API server to provide hierarchy data.
    """
    if not search_terms or column_name not in search_terms:
        print(f"Error: Column '{column_name}' not found in search terms")
        return
    
    # Get the search results for the specified term
    try:
        df = get_ranked_entities(column_name, top_n=10)
        if df.empty:
            print(f"No results found for '{column_name}'")
            return
        
        if match_number < 1 or match_number > len(df):
            print(f"Invalid match number. Please choose between 1 and {len(df)}")
            return
        
        # Get the selected entity
        selected_row = df.iloc[match_number - 1]
        entity_name = selected_row['entity']
        lei_code = selected_row['lei']
        
        if lei_code == "LEI_NOT_FOUND":
            print(f"Cannot retrieve hierarchy: LEI not found for '{entity_name}'")
            return
        
        # Build and display the hierarchy
        hierarchy = build_hierarchy(lei_code)
        
        if hierarchy:
            print_tree(hierarchy)
            
            # Count total entities in hierarchy
            def count_entities(node):
                count = 1  # Count current node
                for child in node['children']:
                    count += count_entities(child)
                return count
            
            total_entities = count_entities(hierarchy)
            print(f"\nTotal entities: {total_entities}")
        else:
            print(f"Failed to build hierarchy for {entity_name}")
            
    except Exception as e:
        print(f"Error: {e}")

# =================================================================================
# Example usage for 3M
# =================================================================================

if __name__ == "__main__":
    lei_3m = "LUZQVYP4VS22CLWDAR65"  # 3M COMPANY
    hierarchy = build_hierarchy(lei_3m)
    print(f"Full hierarchy for LEI {lei_3m}:")
    print_tree(hierarchy)
