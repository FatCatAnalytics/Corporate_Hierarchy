# api_server.py  (same folder as retrieve.py)
import uvicorn
import json
import sys
import io
from contextlib import redirect_stdout, redirect_stderr
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

# Import functions from your updated retrieve.py
try:
    from retrieve import (
        get_ranked_entities,
        get_hierarchy_for_selection,
        get_entity_details,
        build_hierarchy,
        print_tree,
    )
    print("Successfully imported retrieve functions")
except ImportError as e:
    print(f"Error importing retrieve functions: {e}")
    sys.exit(1)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GLOBAL in-memory storage for user-selected pairings (reset when server restarts)
pairings_store = {}

@app.get("/search")
def search(name: str = Query(...), top: int = 5):
    """Search for entities and return ranked results with LEI codes"""
    try:
        print(f"Searching for: {name}, top: {top}")
        df = get_ranked_entities(name, top_n=top)
        
        if df.empty:
            return {"message": f"No results found for '{name}'", "data": []}
        
        # Convert DataFrame to JSON
        result = json.loads(df.to_json(orient="records"))
        print(f"Found {len(result)} results")
        return {"data": result}
        
    except Exception as e:
        print(f"Search error: {e}")
        return {"error": str(e), "data": []}

@app.get("/hierarchy")
def hierarchy(name: str, match: int = 1):
    """Get corporate hierarchy for a specific match"""
    try:
        print(f"Getting hierarchy for: {name}, match: {match}")
        
        # Capture both stdout and stderr to get all output
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()
        
        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            # Create a list with the search term to match expected function signature
            search_terms = [name]
            get_hierarchy_for_selection(search_terms, name, match)
        
        # Get captured output
        stdout_output = stdout_buffer.getvalue()
        stderr_output = stderr_buffer.getvalue()
        
        # Combine outputs
        full_output = ""
        if stdout_output:
            full_output += stdout_output
        if stderr_output:
            full_output += "\n" + stderr_output
            
        if not full_output.strip():
            full_output = f"No hierarchy data found for {name} - match {match}"
            
        print(f"Hierarchy output length: {len(full_output)}")
        return {"text": full_output}
        
    except Exception as e:
        error_msg = f"Error getting hierarchy for {name} - match {match}: {str(e)}"
        print(error_msg)
        return {"error": error_msg}

@app.get("/company")
def company_details(lei: str = Query(...)):
    """Get detailed company information by LEI code"""
    try:
        print(f"Getting company details for LEI: {lei}")
        
        if lei == "LEI_NOT_FOUND":
            return {"error": "LEI not found for this company", "data": None}
        
        company_data = get_entity_details(lei)
        
        if not company_data:
            return {"error": f"No company data found for LEI: {lei}", "data": None}
        
        # Extract relevant information
        attributes = company_data.get('attributes', {})
        entity = attributes.get('entity', {})
        legal_name = entity.get('legalName', {})
        
        # Get legal address
        legal_address = entity.get('legalAddress', {})
        headquarters_address = entity.get('headquartersAddress', {})
        
        # Build response
        response_data = {
            "lei": lei,
            "legal_name": legal_name.get('name', 'N/A'),
            "status": attributes.get('entity', {}).get('status', 'N/A'),
            "legal_form": entity.get('legalForm', {}).get('name', 'N/A'),
            "registration": {
                "country": entity.get('registeredIn', 'N/A'),
                "date": attributes.get('registration', {}).get('initialRegistrationDate', 'N/A'),
                "status": attributes.get('registration', {}).get('status', 'N/A')
            },
            "addresses": {
                "legal": {
                    "first_address_line": legal_address.get('addressLines', ['N/A'])[0] if legal_address.get('addressLines') and len(legal_address.get('addressLines', [])) > 0 else 'N/A',
                    "city": legal_address.get('city', 'N/A'),
                    "region": legal_address.get('region', 'N/A'),
                    "country": legal_address.get('country', 'N/A'),
                    "postal_code": legal_address.get('postalCode', 'N/A')
                },
                "headquarters": {
                    "first_address_line": headquarters_address.get('addressLines', ['N/A'])[0] if headquarters_address.get('addressLines') and len(headquarters_address.get('addressLines', [])) > 0 else 'N/A',
                    "city": headquarters_address.get('city', 'N/A'),
                    "region": headquarters_address.get('region', 'N/A'),
                    "country": headquarters_address.get('country', 'N/A'),
                    "postal_code": headquarters_address.get('postalCode', 'N/A')
                }
            },
            "creation_date": attributes.get('entity', {}).get('creationDate', 'N/A'),
            "lei_registration": {
                "initial_date": attributes.get('registration', {}).get('initialRegistrationDate', 'N/A'),
                "last_update": attributes.get('registration', {}).get('lastUpdateDate', 'N/A'),
                "next_renewal": attributes.get('registration', {}).get('nextRenewalDate', 'N/A'),
                "managing_lou": attributes.get('registration', {}).get('managingLOU', 'N/A')
            }
        }
        
        print(f"Successfully retrieved company details for: {legal_name.get('name', 'Unknown')}")
        return {"data": response_data}
        
    except Exception as e:
        error_msg = f"Error getting company details for LEI {lei}: {str(e)}"
        print(error_msg)
        return {"error": error_msg, "data": None}

# ------------------------------------------------------------------
# Hierarchy by LEI (used when original search term is unavailable)
# ------------------------------------------------------------------


@app.get("/hierarchy_by_lei")
def hierarchy_by_lei(lei: str = Query(...)):
    """Build hierarchy directly from a provided LEI."""
    if not lei or lei == "LEI_NOT_FOUND":
        return {"error": "Invalid LEI provided"}

    try:
        stdout_buffer = io.StringIO()
        with redirect_stdout(stdout_buffer):
            tree = build_hierarchy(lei)
            if tree:
                print_tree(tree)
        output = stdout_buffer.getvalue()
        if not output.strip():
            output = "No hierarchy data returned."
        return {"text": output}
    except Exception as e:
        return {"error": str(e)}

@app.post("/bulk-search")
async def bulk_search(payload: dict):
    """Search multiple entities (max 10). Payload: {"targets": [..], "top": 5}"""
    try:
        targets = payload.get("targets", [])
        top_n = int(payload.get("top", 5))
        if not isinstance(targets, list):
            return {"error": "'targets' must be a list", "data": []}
        if len(targets) == 0:
            return {"error": "No targets provided", "data": []}
        if len(targets) > 10:
            return {"error": "Maximum of 10 targets allowed", "data": []}

        results = []
        for term in targets:
            df = get_ranked_entities(term, top_n=top_n)
            results.append({
                "target": term,
                "matches": json.loads(df.to_json(orient="records")) if not df.empty else []
            })
        return {"data": results}
    except Exception as e:
        return {"error": str(e), "data": []}

@app.post("/pairings")
async def save_pairings(payload: dict):
    """Save selected pairings in memory. Payload: {"pairings": [{"target": str, "selected": {...}}]}"""
    try:
        pairs = payload.get("pairings", [])
        if not isinstance(pairs, list):
            return {"error": "'pairings' must be a list"}
        for p in pairs:
            target = p.get("target")
            selected = p.get("selected")
            if target and selected:
                pairings_store[target] = selected
        return {"status": "saved", "count": len(pairings_store)}
    except Exception as e:
        return {"error": str(e)}

@app.get("/pairings")
def get_pairings():
    """Return saved pairings for dropdown."""
    return {"data": list(pairings_store.values())}

@app.get("/health")
def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "message": "API server is running"}

if __name__ == "__main__":
    print("Starting GLEIF API server...")
    print("Health check: http://127.0.0.1:8000/health")
    print("API docs: http://127.0.0.1:8000/docs")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
