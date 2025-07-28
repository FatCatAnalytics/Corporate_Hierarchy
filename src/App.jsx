import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import './styles.css';
import { MapContainer, TileLayer, CircleMarker, Popup, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// Map content component to handle markers and lines
function MapContent({ hierarchyGeo, countryCentroids }) {
  const [positions, setPositions] = useState({});
  const map = useMap();

  useEffect(() => {
    const loadPositions = async () => {
      const posMap = {};
      
      for (const node of hierarchyGeo) {
        if (countryCentroids[node.country]) {
          posMap[node.lei] = countryCentroids[node.country];
        } else {
          posMap[node.lei] = [0, 0]; // fallback
        }
      }
      
      setPositions(posMap);
      
      // Fit bounds after positions are set
      const coords = Object.values(posMap).filter(p => p[0] !== 0 || p[1] !== 0);
      if (coords.length > 0 && map) {
        setTimeout(() => map.fitBounds(coords, { padding: [30, 30] }), 100);
      }
    };
    
    if (hierarchyGeo.length > 0) {
      loadPositions();
    }
  }, [hierarchyGeo, countryCentroids, map]);

  const rootLei = hierarchyGeo.find(n => !n.parent)?.lei;

  return (
    <>
      {/* Markers */}
      {hierarchyGeo.map((node, i) => {
        const pos = positions[node.lei];
        if (!pos) return null;
        
        const isRoot = node.lei === rootLei;
        return (
          <CircleMarker
            key={node.lei}
            center={pos}
            radius={isRoot ? 10 : 6}
            pathOptions={{ color: isRoot ? '#e74c3c' : '#3498db' }}
          >
            <Popup>
              {node.name}<br/>
              LEI: {node.lei}<br/>
              S&P: {node.spid}
            </Popup>
          </CircleMarker>
        );
      })}
      
      {/* Lines */}
      {hierarchyGeo
        .filter(node => node.parent && positions[node.parent] && positions[node.lei])
        .map((node, i) => (
          <Polyline
            key={`line-${node.lei}`}
            positions={[positions[node.parent], positions[node.lei]]}
            pathOptions={{ color: '#7f8c8d', weight: 1 }}
          />
        ))
      }
    </>
  );
}

function App() {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState([]);
  const [hierarchy, setHierarchy] = useState('');
  const [hierarchyGeo, setHierarchyGeo] = useState([]);
  const [hierarchyView, setHierarchyView] = useState('tree'); // 'tree' | 'map'
  const [coordCache, setCoordCache] = useState({});
  const mapRef = useRef(null);
  const [companyDetails, setCompanyDetails] = useState(null);
  const [currentView, setCurrentView] = useState('search'); // 'search', 'company', 'hierarchy'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progressMessage, setProgressMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [activeTab, setActiveTab] = useState('single'); // 'single' | 'bulk'

  // Bulk search states
  const [bulkInput, setBulkInput] = useState('');
  const [bulkResults, setBulkResults] = useState([]); // [{ target, matches: [...] }]
  const [bulkSelections, setBulkSelections] = useState({}); // { target: selectedMatchObj }
  const [pairings, setPairings] = useState([]); // saved on backend
  const [selectedPairingLei, setSelectedPairingLei] = useState('');

  // ------------------------------------------------------------------
  // Bulk search helpers
  // ------------------------------------------------------------------
  const parseBulkTargets = (input) => {
    return input
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter((t) => t)
      .slice(0, 10); // max 10
  };

  const handleBulkSearch = async () => {
    const targets = parseBulkTargets(bulkInput);
    if (targets.length === 0) return;
    setLoading(true);
    setError('');
    setProgress(0);
    setBulkResults([]);
    try {
      updateProgress('📡 Running bulk search...', 30);
      const response = await axios.post('http://127.0.0.1:8000/bulk-search', {
        targets,
        top: 5,
      });
      updateProgress('✅ Bulk search complete', 100);
      if (response.data.error) {
        setError(response.data.error);
      } else {
        setBulkResults(response.data.data);
        // default selections: first match per target
        const initialSel = {};
        response.data.data.forEach((row) => {
          if (row.matches && row.matches.length > 0) {
            initialSel[row.target] = row.matches[0];
          }
        });
        setBulkSelections(initialSel);
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
    setProgressMessage('');
    setProgress(0);
  };

  const handleSelectMatch = (target, matchObj) => {
    setBulkSelections({ ...bulkSelections, [target]: matchObj });
  };

  const handleSavePairings = async () => {
    const payload = {
      pairings: Object.entries(bulkSelections).map(([target, selected]) => ({
        target,
        selected,
      })),
    };
    try {
      await axios.post('http://127.0.0.1:8000/pairings', payload);
      const res = await axios.get('http://127.0.0.1:8000/pairings');
      setPairings(res.data.data || []);
    } catch (err) {
      setError('Error saving pairings: ' + err.message);
    }
  };

  const handleSelectPairing = async (lei) => {
    if (!lei) return;
    setSelectedPairingLei(lei);
    // Reuse existing company details workflow
    setSearchTerm('');
    setResults([]);
    setCurrentView('search');
    setCompanyDetails(null);
    setHierarchy('');
    setHierarchyGeo([]);
    setHierarchyView('tree');
    setError('');

    // Fetch company details & hierarchy buttons will work as in single search view
    setLoading(true);
    try {
      const res = await axios.get('http://127.0.0.1:8000/company', {
        params: { lei },
      });
      if (res.data.data) {
        setCompanyDetails(res.data.data);
        setCurrentView('company');
      } else {
        setError(res.data.error || 'No data');
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const updateProgress = (message, percent) => {
    setProgressMessage(message);
    setProgress(percent);
  };

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    
    setLoading(true);
    setError('');
    setHierarchy('');
    setHierarchyGeo([]);
    setHierarchyView('tree');
    setCompanyDetails(null);
    setCurrentView('search');
    setProgress(0);
    
    try {
      updateProgress(`🔍 Searching for "${searchTerm}"...`, 20);
      console.log(`Searching for: ${searchTerm}`);
      
      updateProgress('📡 Contacting GLEIF API...', 40);
      const response = await axios.get('http://127.0.0.1:8000/search', {
        params: { name: searchTerm, top: 5 }
      });
      
      updateProgress('🤖 Processing semantic similarity scores...', 70);
      console.log('Search response:', response.data);
      
      // Simulate processing time for better UX
      await new Promise(resolve => setTimeout(resolve, 500));
      
      updateProgress('✅ Search completed!', 100);
      
      // Handle the API response format
      if (response.data.error) {
        setError(response.data.error);
        setResults([]);
      } else if (response.data.data) {
        setResults(response.data.data);
        if (response.data.data.length === 0) {
          setError(`No results found for "${searchTerm}"`);
        }
      } else {
        setError('Unexpected response format');
        setResults([]);
      }
      
    } catch (error) {
      console.error('Search error:', error);
      setError(`Connection error: ${error.message}`);
      setResults([]);
    }
    
    setLoading(false);
    setProgressMessage('');
    setProgress(0);
  };

  const handleViewCompany = async (index) => {
    const selectedEntity = results[index];
    setLoading(true);
    setError('');
    setProgress(0);
    // Clear hierarchy data when viewing a new company
    setHierarchy('');
    setHierarchyGeo([]);
    setHierarchyView('tree');
    
    try {
      updateProgress(`🏢 Loading details for: ${selectedEntity.entity}`, 20);
      console.log(`Getting company details for LEI: ${selectedEntity.lei}`);
      
      updateProgress('📡 Fetching company data from GLEIF...', 50);
      const response = await axios.get('http://127.0.0.1:8000/company', {
        params: { lei: selectedEntity.lei }
      });
      
      updateProgress('📊 Processing company information...', 80);
      console.log('Company details response:', response.data);
      
      updateProgress('✅ Company details loaded!', 100);
      
      if (response.data.error) {
        setError(response.data.error);
      } else if (response.data.data) {
        setCompanyDetails(response.data.data);
        setCurrentView('company');
      } else {
        setError('No company data received');
      }
      
    } catch (error) {
      console.error('Company details error:', error);
      setError(`Connection error: ${error.message}`);
    }
    
    setLoading(false);
    setProgressMessage('');
    setProgress(0);
  };

  const handleHierarchy = async (index) => {
    const selectedEntity = results[index];
    setLoading(true);
    setError('');
    setProgress(0);
    
    try {
      updateProgress(`🏢 Selected: ${selectedEntity.entity}`, 10);
      console.log(`Getting hierarchy for: ${searchTerm}, match: ${index + 1}`);
      
      updateProgress('🔍 Looking up LEI code...', 20);
      await new Promise(resolve => setTimeout(resolve, 300));
      
      updateProgress('🌐 Fetching ultimate parent...', 40);
      await new Promise(resolve => setTimeout(resolve, 300));
      
      updateProgress('📊 Building corporate hierarchy...', 60);
      const response = await axios.get('http://127.0.0.1:8000/hierarchy', {
        params: { name: searchTerm, match: index + 1 }
      });
      
      updateProgress('🔄 Processing subsidiaries...', 80);
      console.log('Hierarchy response:', response.data);
      
      updateProgress('✅ Hierarchy complete!', 100);
      
      if (response.data.error) {
        setHierarchy(`❌ Error: ${response.data.error}`);
      } else if (response.data.text) {
        setHierarchy(response.data.text);
        setCurrentView('hierarchy');
      } else {
        setHierarchy('❌ No hierarchy data received');
      }
      
    } catch (error) {
      console.error('Hierarchy error:', error);
      setHierarchy(`❌ Connection error: ${error.message}`);
    }
    
    setLoading(false);
    setProgressMessage('');
    setProgress(0);
  };

  const handleHierarchyFromCompany = async () => {
    if (!companyDetails) return;
    
    setLoading(true);
    setError('');
    setProgress(0);
    // Clear previous hierarchy geo data
    setHierarchyGeo([]);
    
    try {
      updateProgress(`🏢 Building hierarchy for: ${companyDetails.legal_name}`, 10);
      
      updateProgress('🌐 Fetching ultimate parent...', 30);
      await new Promise(resolve => setTimeout(resolve, 300));
      
      updateProgress('📊 Building corporate hierarchy...', 60);
      const response = await axios.get('http://127.0.0.1:8000/hierarchy_by_lei', {
        params: { lei: companyDetails.lei }
      });
      
      updateProgress('🔄 Processing subsidiaries...', 80);
      console.log('Hierarchy response:', response.data);
      
      updateProgress('✅ Hierarchy complete!', 100);
      
      if (response.data.error) {
        setHierarchy(`❌ Error: ${response.data.error}`);
      } else if (response.data.text) {
        setHierarchy(response.data.text);
        setCurrentView('hierarchy');
      } else {
        setHierarchy('❌ No hierarchy data received');
      }
      
    } catch (error) {
      console.error('Hierarchy error:', error);
      setHierarchy(`❌ Connection error: ${error.message}`);
    }
    
    setLoading(false);
    setProgressMessage('');
    setProgress(0);
  };

  const clearResults = () => {
    setResults([]);
    setHierarchy('');
    setCompanyDetails(null);
    setCurrentView('search');
    setError('');
    setProgressMessage('');
    setProgress(0);
  };

  const backToResults = () => {
    setCurrentView('search');
    setCompanyDetails(null);
    setHierarchy('');
    setError('');
  };

  const backToCompany = () => {
    setCurrentView('company');
    setHierarchy('');
    setError('');
  };

  const countryCentroids = {
    US: [39.5, -98.35],
    IE: [53.4, -8],
    GB: [55, -3],
    CA: [56.13, -106.35],
    DE: [51.17, 10.45],
    FR: [46.2, 2.2],
    IN: [21, 78],
    JP: [36, 138],
    CN: [35, 103],
    AU: [-25, 133],
    MX: [23.6, -102.5],
    CL: [-30, -71],
    NL: [52.1, 5.3],
    SG: [1.3, 103.8],
    BR: [-14.2, -51.9],
    KR: [35.9, 127.8],
    TW: [23.8, 120.9],
    HK: [22.4, 114.2],
    CH: [46.8, 8.2],
    AT: [47.5, 14.5],
    BE: [50.5, 4.5],
    IT: [41.9, 12.6],
    ES: [40.5, -3.7],
    SE: [60.1, 18.6],
    NO: [60.5, 8.5],
    FI: [61.9, 25.7],
    DK: [56.3, 9.5],
    PL: [51.9, 19.1],
    CZ: [49.8, 15.5],
    HU: [47.2, 19.5],
    PT: [39.4, -8.2],
    GR: [39.1, 21.8],
    TR: [38.9, 35.2],
    RU: [61.5, 105.3],
    UA: [48.4, 31.2],
    ZA: [-30.6, 22.9],
    EG: [26.8, 30.8],
    MA: [31.8, -7.1],
    NG: [9.1, 8.7],
    KE: [-0.0, 37.9],
    TH: [15.9, 100.9],
    VN: [14.1, 108.3],
    MY: [4.2, 101.9],
    ID: [-0.8, 113.9],
    PH: [12.9, 121.8],
    AR: [-38.4, -63.6],
    CO: [4.6, -74.1],
    PE: [-9.2, -75.0],
    VE: [6.4, -66.6],
    UY: [-32.5, -55.8],
    EC: [-1.8, -78.2],
    BO: [-16.3, -63.6],
    PY: [-23.4, -58.4],
    GY: [4.9, -58.9],
    SR: [3.9, -56.0],
    FK: [-51.8, -59.5],
    IL: [31.0, 34.9],
    SA: [23.9, 45.1],
    AE: [23.4, 53.8],
    QA: [25.3, 51.2],
    KW: [29.3, 47.5],
    BH: [25.9, 50.6],
    OM: [21.5, 55.9],
    JO: [30.6, 36.2],
    LB: [33.9, 35.9],
    SY: [34.8, 38.0],
    IQ: [33.2, 43.7],
    IR: [32.4, 53.7],
    AF: [33.9, 67.7],
    PK: [30.4, 69.3],
    BD: [23.7, 90.4],
    LK: [7.9, 80.8],
    MV: [3.2, 73.2],
    NP: [28.4, 84.1],
    BT: [27.5, 90.4],
    MM: [21.9, 95.9],
    KH: [12.6, 104.9],
    LA: [19.9, 102.5],
    MN: [46.9, 103.8],
    KZ: [48.0, 66.9],
    KG: [41.2, 74.8],
    TJ: [38.9, 71.3],
    UZ: [41.4, 64.6],
    TM: [38.97, 59.56],
    AZ: [40.1, 47.6],
    GE: [42.3, 43.4],
    AM: [40.1, 45.0],
    NZ: [-40.9, 174.8]
  };

  const getCoords = async (iso) => {
    if (coordCache[iso]) return coordCache[iso];
    if (countryCentroids[iso]) {
      setCoordCache((c)=>({...c, [iso]: countryCentroids[iso]}));
      return countryCentroids[iso];
    }
    try {
      const resp = await fetch(`https://restcountries.com/v3.1/alpha/${iso}`);
      const data = await resp.json();
      if (Array.isArray(data) && data[0]?.latlng) {
        const coords = [data[0].latlng[0], data[0].latlng[1]];
        setCoordCache((c)=>({...c, [iso]: coords}));
        return coords;
      }
    } catch (err) { console.error('Country fetch error', err); }
    // fallback to 0,0
    return [0,0];
  };

  const fetchHierarchyGeo = async () => {
    if (!companyDetails) return;
    try {
      const res = await axios.get('http://127.0.0.1:8000/hierarchy_geo', {
        params: { lei: companyDetails.lei },
      });
      if (res.data.data) {
        setHierarchyGeo(res.data.data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>GLEIF Entity Search</h1>
        <p>Search for corporate entities and explore their hierarchies</p>
      </header>

      {/* Tab navigation */}
      <div className="tab-bar">
        <button 
          className={activeTab === 'single' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('single')}
        >
          🔎 Single Search
        </button>
        <button 
          className={activeTab === 'bulk' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('bulk')}
        >
          📑 Bulk Search
        </button>
      </div>

      {activeTab === 'single' && (
        <>
          {/* SINGLE SEARCH UI (existing) */}
          <div className="search-section">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Enter company name (e.g., Apple, Microsoft, 3M)"
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              disabled={loading}
            />
            <button onClick={handleSearch} disabled={loading || !searchTerm.trim()}>
              {loading ? '⏳ Processing...' : '🔍 Search'}
            </button>
            {(results.length > 0 || hierarchy || companyDetails || error) && (
              <button onClick={clearResults} className="clear-btn" disabled={loading}>
                🗑️ Clear
              </button>
            )}
          </div>
        </>
      )}

      {activeTab === 'bulk' && (
        <div className="bulk-section">
          <textarea
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            placeholder="Enter company names separated by commas or new lines (max 10)"
            rows={4}
          />
          <button onClick={handleBulkSearch} disabled={loading || !bulkInput.trim()}>
            {loading ? '⏳ Processing...' : '🔍 Bulk Search'}
          </button>

          {bulkResults.length > 0 && (
            <div className="bulk-results">
              <h3>🔢 Bulk Search Results</h3>
              <table>
                <thead>
                  <tr>
                    <th>Target</th>
                    <th colSpan={5}>Matches (click to select top match)</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkResults.map((row, idx) => (
                    <tr key={idx}>
                      <td>{row.target}</td>
                      {Array.from({ length: 5 }).map((_, i) => {
                        const match = row.matches[i];
                        if (!match) return <td key={i}>—</td>;
                        const isSelected = bulkSelections[row.target]?.lei === match.lei;
                        return (
                          <td
                            key={i}
                            className={isSelected ? 'selected-match' : ''}
                            onClick={() => handleSelectMatch(row.target, match)}
                          >
                            {match.entity}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="primary" onClick={handleSavePairings} disabled={loading}>
                💾 Save Pairings
              </button>
            </div>
          )}

          {pairings.length > 0 && (
            <div className="pairings-section">
              <h3>🎯 Saved Pairings</h3>
              <select value={selectedPairingLei} onChange={(e) => handleSelectPairing(e.target.value)}>
                <option value="">Select a company</option>
                {pairings.map((p, i) => (
                  <option value={p.lei} key={i}>{p.entity}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Progress Bar and Status */}
      {loading && (
        <div className="progress-section">
          <div className="progress-container">
            <div className="progress-bar">
              <div 
                className="progress-fill" 
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <div className="progress-message">
              {progressMessage}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="error-section">
          <h3>⚠️ Error</h3>
          <p>{error}</p>
        </div>
      )}

      {results.length > 0 && currentView === 'search' && (
        <div className="results-section">
          <h2>🎯 Search Results ({results.length} found)</h2>
          <p className="results-subtitle">Select a company below to view its details</p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>🏢 Entity Name</th>
                <th>🔢 LEI Code</th>
                <th>📊 Similarity Score</th>
                <th>⚡ Action</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, index) => (
                <tr key={index} className={result.lei === 'LEI_NOT_FOUND' ? 'no-lei' : ''}>
                  <td>{index + 1}</td>
                  <td className="entity-name">{result.entity}</td>
                  <td className="lei-code">
                    {result.lei === 'LEI_NOT_FOUND' ? (
                      <span className="no-lei-text">❌ Not Found</span>
                    ) : (
                      result.lei
                    )}
                  </td>
                  <td className="score">
                    <div className="score-container">
                      <span className="score-value">{result.score?.toFixed(3) || 'N/A'}</span>
                      <div className="score-bar">
                        <div 
                          className="score-fill" 
                          style={{ width: `${(result.score || 0) * 100}%` }}
                        ></div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <button 
                      onClick={() => handleViewCompany(index)}
                      disabled={loading || result.lei === 'LEI_NOT_FOUND'}
                      className="hierarchy-btn"
                    >
                      {loading ? '⏳ Loading...' : '🏢 View Company'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {companyDetails && currentView === 'company' && (
        <div className="company-details-section">
          <div className="navigation-header">
            <button onClick={backToResults} className="nav-btn">
              ← Back to Results
            </button>
            <h2>🏢 Company Details</h2>
          </div>
          
          <div className="company-info">
            <div className="company-header">
              <h3>{companyDetails.legal_name}</h3>
              <span className="lei-badge">LEI: {companyDetails.lei}</span>
            </div>
            
            <div className="company-grid">
              <div className="info-card">
                <h4>📋 Basic Information</h4>
                <div className="info-row">
                  <span className="label">Legal Name:</span>
                  <span className="value">{companyDetails.legal_name}</span>
                </div>
                <div className="info-row">
                  <span className="label">Status:</span>
                  <span className="value">{companyDetails.status}</span>
                </div>
                <div className="info-row">
                  <span className="label">Creation Date:</span>
                  <span className="value">{companyDetails.creation_date}</span>
                </div>
              </div>

              <div className="info-card">
                <h4>📍 Legal Address</h4>
                <div className="address">
                  <div>{companyDetails.addresses.legal.first_address_line}</div>
                  <div>{companyDetails.addresses.legal.city}, {companyDetails.addresses.legal.region}</div>
                  <div>{companyDetails.addresses.legal.postal_code}</div>
                  <div>{companyDetails.addresses.legal.country}</div>
                </div>
              </div>

              <div className="info-card">
                <h4>🏢 Headquarters</h4>
                <div className="address">
                  <div>{companyDetails.addresses.headquarters.first_address_line}</div>
                  <div>{companyDetails.addresses.headquarters.city}, {companyDetails.addresses.headquarters.region}</div>
                  <div>{companyDetails.addresses.headquarters.postal_code}</div>
                  <div>{companyDetails.addresses.headquarters.country}</div>
                </div>
              </div>

              <div className="info-card">
                <h4>🔢 LEI Registration</h4>
                <div className="info-row">
                  <span className="label">Registration Status:</span>
                  <span className="value">{companyDetails.registration.status}</span>
                </div>
                <div className="info-row">
                  <span className="label">Initial Date:</span>
                  <span className="value">{companyDetails.lei_registration.initial_date}</span>
                </div>
                <div className="info-row">
                  <span className="label">Last Update:</span>
                  <span className="value">{companyDetails.lei_registration.last_update}</span>
                </div>
                <div className="info-row">
                  <span className="label">Next Renewal:</span>
                  <span className="value">{companyDetails.lei_registration.next_renewal}</span>
                </div>
                <div className="info-row">
                  <span className="label">Managing LOU:</span>
                  <span className="value">{companyDetails.lei_registration.managing_lou}</span>
                </div>
                <div className="info-row">
                  <span className="label">Registered At (ID):</span>
                  <span className="value">{companyDetails.lei_registration.registered_at}</span>
                </div>
                <div className="info-row">
                  <span className="label">Registered As:</span>
                  <span className="value">{companyDetails.lei_registration.registered_as}</span>
                </div>
              </div>
            </div>
            
            <div className="action-section">
              <button 
                onClick={handleHierarchyFromCompany}
                disabled={loading}
                className="hierarchy-btn primary"
              >
                {loading ? '⏳ Building Hierarchy...' : '🌳 View Corporate Hierarchy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {hierarchy && currentView === 'hierarchy' && (
        <div className="hierarchy-section">
          <div className="navigation-header">
            {companyDetails ? (
              <button onClick={backToCompany} className="nav-btn">
                ← Back to Company Details
              </button>
            ) : (
              <button onClick={backToResults} className="nav-btn">
                ← Back to Results
              </button>
            )}
            <h2>🌳 Corporate Hierarchy</h2>
          </div>
          {/* sub tabs */}
          <div className="sub-tab-bar">
            <button className={hierarchyView==='tree'?'subtab active':'subtab'} onClick={()=>setHierarchyView('tree')}>🌳 Tree</button>
            <button className={hierarchyView==='map'?'subtab active':'subtab'} onClick={()=>{setHierarchyView('map'); if(hierarchyGeo.length===0) fetchHierarchyGeo();}}>🗺 Map</button>
          </div>
          {hierarchyView==='tree' && (
            <>
              <div className="hierarchy-info">
                <p>📋 Complete organizational structure showing parent-child relationships</p>
              </div>
              <div className="hierarchy-content">
                <pre>{hierarchy}</pre>
              </div>
            </>
          )}
          {hierarchyView==='map' && (
            <div className="map-container">
              {hierarchyGeo.length>0 ? (
                <MapContainer center={[20,0]} zoom={2} style={{height:'500px', width:'100%'}} ref={mapRef}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <MapContent hierarchyGeo={hierarchyGeo} countryCentroids={countryCentroids} />
                </MapContainer>
              ): (<p>Loading map data...</p>)}
            </div>
          )}
        </div>
      )}
      
      <footer>
        <p>⚡ Powered by GLEIF API • 🔄 Real-time entity data</p>
      </footer>
    </div>
  );
}

// Render the app
const container = document.getElementById('root');
const root = createRoot(container);
root.render(<App />);

export default App;