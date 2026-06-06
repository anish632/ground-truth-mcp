/**
 * Ground Truth MCP - Usage Data Retrieval Script
 * Pulls usage data from different deployment platforms (Glama, Smithery, Xpay)
 * 
 * Usage: node pull-usage-data.mjs [--detailed] [--historical] [--export FILE]
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// Configuration
const MAIN_SERVER = 'https://ground-truth-mcp.anishdasmail.workers.dev';
const XPAY_SERVER = 'https://ground-truth-mcp-xpay.anishdasmail.workers.dev';
const DASHBOARD_API = 'https://ground-truth-dashboard.vercel.app/api/track';

// Color codes for console output
const colors = {
  info: '\x1b[34m',
  success: '\x1b[32m', 
  warning: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m'
};

function logInfo(message) {
  console.log(`${colors.info}[INFO]${colors.reset} ${message}`);
}

function logSuccess(message) {
  console.log(`${colors.success}[SUCCESS]${colors.reset} ${message}`);
}

function logWarning(message) {
  console.log(`${colors.warning}[WARNING]${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.error}[ERROR]${colors.reset} ${message}`);
}

// Simple HTTP client
async function httpRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = options.timeout || 10000;
  
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': options.accept || 'application/json',
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    let text = await response.text();
    
    // Try to parse as JSON
    try {
      return {
        status: response.status,
        data: JSON.parse(text),
        text
      };
    } catch {
      return {
        status: response.status,
        data: null,
        text
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    return {
      status: 0,
      error: error.message,
      data: null,
      text: ''
    };
  }
}

// MCP-specific client
async function mcpRequest(url, method, body, sessionId = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };
  
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }
  
  return httpRequest(url, {
    method,
    headers,
    body,
    accept: 'application/json, text/event-stream'
  });
}

// Usage data collector
const usageData = {
  mainServer: {},
  xpayServer: {},
  glama: {},
  smithery: {},
  dashboard: {},
  kvStructure: {}
};

// Test main server
async function checkMainServer() {
  logInfo('Checking main server...');
  
  try {
    // Try stats endpoint
    let result = await httpRequest(`${MAIN_SERVER}/stats`);
    if (result.status === 200) {
      usageData.mainServer.stats = result.data;
      logSuccess('Main server stats retrieved');
      return;
    }
    
    // Try MCP list_resources
    let response = await mcpRequest(`${MAIN_SERVER}/mcp`, 'POST', {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'usage-query',
          version: '1.0.0'
        }
      },
      id: 1
    });
    
    if (response.status !== 200) {
      logWarning(`Main server MCP initialize failed: ${response.status}`);
      return;
    }
    
    // Extract session ID from headers (would need to parse response headers)
    // For now, we'll just try list_resources without session
    response = await mcpRequest(`${MAIN_SERVER}/mcp`, 'POST', {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'list_resources'
      },
      id: 2
    });
    
    if (response.status === 200) {
      usageData.mainServer.tools = response.data?.result?.content || [];
      logSuccess('Main server tools listed');
    } else {
      logWarning(`Main server list_resources failed: ${response.status}`);
    }
    
  } catch (error) {
    logError(`Main server check error: ${error.message}`);
  }
}

// Test Xpay server
async function checkXpayServer() {
  logInfo('Checking Xpay server...');
  
  try {
    // Try MCP list_resources on Xpay server
    let response = await mcpRequest(`${XPAY_SERVER}/mcp`, 'POST', {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'usage-query-xpay',
          version: '1.0.0'
        }
      },
      id: 1
    });
    
    if (response.status !== 200) {
      logWarning(`Xpay server MCP initialize failed: ${response.status}`);
      return;
    }
    
    response = await mcpRequest(`${XPAY_SERVER}/mcp`, 'POST', {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'list_resources'
      },
      id: 2
    });
    
    if (response.status === 200) {
      usageData.xpayServer.tools = response.data?.result?.content || [];
      logSuccess('Xpay server tools listed');
    } else {
      logWarning(`Xpay server list_resources failed: ${response.status}`);
    }
    
  } catch (error) {
    logError(`Xpay server check error: ${error.message}`);
  }
}

// Check Glama platform
async function checkGlama() {
  logInfo('Checking Glama platform...');
  
  try {
    const glamaUrl = 'https://glama.ai/mcp/servers/anish632/ground-truth-mcp';
    
    // Try to get server info
    let result = await httpRequest(glamaUrl);
    
    if (result.status === 200) {
      usageData.glama.pageAvailable = true;
      
      // Extract usage-related info from HTML
      const html = result.text;
      const metrics = {};
      
      // Look for install counts, scores, etc.
      const scoreMatch = html.match(/score[\/:\s](\d+(\.\d+)?)/i);
      if (scoreMatch) {
        metrics.score = parseFloat(scoreMatch[1]);
      }
      
      const installMatch = html.match(/installs?[\/:\s](\d+)/i);
      if (installMatch) {
        metrics.installs = parseInt(installMatch[1]);
      }
      
      usageData.glama.metrics = metrics;
      logSuccess('Glama server profile retrieved');
    } else {
      logWarning(`Glama server profile returned ${result.status}`);
    }
    
  } catch (error) {
    logError(`Glama check error: ${error.message}`);
  }
}

// Check Smithery platform
async function checkSmithery() {
  logInfo('Checking Smithery platform...');
  
  try {
    // Try Smithery API
    const smitheryApiUrl = 'https://smithery.ai/api/servers/anish632/ground-truth';
    
    let result = await httpRequest(smitheryApiUrl);
    
    if (result.status === 200 && result.data) {
      usageData.smithery.apiData = result.data;
      logSuccess('Smithery API data retrieved');
      return;
    }
    
    // Try public page
    const smitheryUrl = 'https://smithery.ai/servers/anish632/ground-truth';
    result = await httpRequest(smitheryUrl);
    
    if (result.status === 200) {
      usageData.smithery.pageAvailable = true;
      
      // Extract usage-related info from HTML
      const html = result.text;
      const metrics = {};
      
      const installMatch = html.match(/install[s\s](\d+)/i);
      if (installMatch) {
        metrics.installs = parseInt(installMatch[1]);
      }
      
      usageData.smithery.metrics = metrics;
      logSuccess('Smithery server page retrieved');
    } else {
      logWarning(`Smithery server page returned ${result.status}`);
    }
    
  } catch (error) {
    logError(`Smithery check error: ${error.message}`);
  }
}

// Check dashboard API
async function checkDashboard() {
  logInfo('Checking dashboard API...');
  
  try {
    const testData = {
      event_name: 'usage_query',
      timestamp: new Date().toISOString()
    };
    
    let result = await httpRequest(DASHBOARD_API, {
      method: 'POST',
      body: testData
    });
    
    if (result.status === 200) {
      usageData.dashboard.accessible = true;
      logSuccess('Dashboard API is accessible');
    } else {
      usageData.dashboard.status = result.status;
      logWarning(`Dashboard API returned ${result.status}`);
    }
    
  } catch (error) {
    logError(`Dashboard check error: ${error.message}`);
  }
}

// Main function
async function main() {
  console.log('==========================================');
  console.log('Ground Truth MCP - Usage Data Retrieval');
  console.log('==========================================\n');
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  const options = {
    detailed: args.includes('--detailed'),
    historical: args.includes('--historical'),
    export: null
  };
  
  const exportIndex = args.indexOf('--export');
  if (exportIndex !== -1 && args[exportIndex + 1]) {
    options.export = args[exportIndex + 1];
  }
  
  // Check all platforms
  await Promise.all([
    checkMainServer(),
    checkXpayServer(),
    checkGlama(),
    checkSmithery(),
    checkDashboard()
  ]);
  
  // Add KV structure info
  usageData.kvStructure = {
    description: 'Usage data is stored in Cloudflare KV with the following structure:',
    keyPattern: 'usage:{subjectType}:{month}:{subjectId}',
    valueStructure: {
      month: 'string (YYYY-MM format)',
      subjectType: 'enum: "free" | "free_verify_claim" | "pro"',
      subjectId: 'string (hashed identifier)',
      total: 'number (total requests)',
      byTool: 'object (per-tool breakdown)',
      updatedAt: 'string (ISO timestamp)'
    },
    accessNote: 'Direct KV access requires Cloudflare API credentials and the API_KEYS namespace binding'
  };
  
  // Display summary
  console.log('\n=== Usage Data Summary ===\n');
  
  console.log('📊 Main Server:');
  console.log(`  - Tools available: ${usageData.mainServer.tools?.length || 0}`);
  if (usageData.mainServer.tools?.length) {
    console.log(`  - Available tools: ${usageData.mainServer.tools.map(t => t.name).join(', ')}`);
  }
  
  console.log('\n💳 Xpay Server:');
  console.log(`  - Tools available: ${usageData.xpayServer.tools?.length || 0}`);
  if (usageData.xpayServer.tools?.length) {
    console.log(`  - Available tools: ${usageData.xpayServer.tools.map(t => t.name).join(', ')}`);
  }
  
  console.log('\n🎯 Glama:');
  console.log(`  - Profile accessible: ${usageData.glama.pageAvailable ? 'Yes' : 'No'}`);
  if (usageData.glama.metrics?.score) {
    console.log(`  - Score: ${usageData.glama.metrics.score}`);
  }
  if (usageData.glama.metrics?.installs) {
    console.log(`  - Installs: ${usageData.glama.metrics.installs}`);
  }
  
  console.log('\n🔧 Smithery:');
  console.log(`  - Page accessible: ${usageData.smithery.pageAvailable ? 'Yes' : 'No'}`);
  if (usageData.smithery.metrics?.installs) {
    console.log(`  - Installs: ${usageData.smithery.metrics.installs}`);
  }
  
  console.log('\n📈 Dashboard:');
  console.log(`  - API accessible: ${usageData.dashboard.accessible ? 'Yes' : 'No'}`);
  if (usageData.dashboard.status) {
    console.log(`  - Status: ${usageData.dashboard.status}`);
  }
  
  console.log('\n💾 Cloudflare KV Structure:');
  console.log(`  - ${usageData.kvStructure.description}`);
  console.log(`  - Key Pattern: ${usageData.kvStructure.keyPattern}`);
  console.log(`  - Access: ${usageData.kvStructure.accessNote}`);
  
  // Export if requested
  if (options.export) {
    try {
      const exportData = {
        timestamp: new Date().toISOString(),
        usageData,
        summary: {
          mainServer: {
            toolsAvailable: usageData.mainServer.tools?.length || 0,
            toolNames: usageData.mainServer.tools?.map(t => t.name) || []
          },
          xpayServer: {
            toolsAvailable: usageData.xpayServer.tools?.length || 0,
            toolNames: usageData.xpayServer.tools?.map(t => t.name) || []
          },
          glama: usageData.glama,
          smithery: usageData.smithery,
          dashboard: usageData.dashboard
        }
      };
      
      await writeFile(options.export, JSON.stringify(exportData, null, 2));
      logSuccess(`Usage data exported to ${options.export}`);
    } catch (error) {
      logError(`Failed to export usage data: ${error.message}`);
    }
  }
  
  console.log('\n==========================================');
  console.log('Usage data retrieval complete.');
  console.log('\nFor detailed usage analytics, you may need to:');
  console.log('1. Access Cloudflare KV directly via Cloudflare API');
  console.log('2. Check the remote dashboard at', DASHBOARD_API);
  console.log('3. Review individual platform dashboards (Glama, Smithery)');
  console.log('4. Use the MCP server\'s built-in usage tracking with proper API keys');
  console.log('==========================================');
}

// Run main function
main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});