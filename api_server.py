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
    from retrieve import get_ranked_entities, get_hierarchy_for_selection, get_entity_details
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

@app.get("/health")
def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "message": "API server is running"}

if __name__ == "__main__":
    print("Starting GLEIF API server...")
    print("Health check: http://127.0.0.1:8000/health")
    print("API docs: http://127.0.0.1:8000/docs")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
