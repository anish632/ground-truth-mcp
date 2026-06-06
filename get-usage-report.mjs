/**
 * Ground Truth MCP - Usage Report Generator
 * Pulls publicly available usage data from Glama, Smithery, and Xpay platforms
 * 
 * Usage: node get-usage-report.mjs [--export FILE]
 */

// Configuration
const MAIN_SERVER = 'https://ground-truth-mcp.anishdasmail.workers.dev';
const GLASS_URL = 'https://glass.sh';

// Color codes
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

// HTTP client
async function fetchUrl(url, options = {}) {
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Accept': options.accept || 'application/json',
        'Content-Type': 'application/json',
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeout: 10000
    });
    
    const text = await response.text();
    
    try {
      return {
        status: response.status,
        json: JSON.parse(text),
        text
      };
    } catch {
      return {
        status: response.status,
        json: null,
        text
      };
    }
  } catch (error) {
    return {
      status: 0,
      json: null,
      text: '',
      error: error.message
    };
  }
}

// Extract usage metrics from HTML
function extractMetrics(html, platform) {
  const metrics = {};
  
  switch (platform) {
    case 'glama':
      // Extract score from Glama
      const scoreMatch = html.match(/badges[\/]score\.svg[^>]*?(\d+(?:\.\d+)?)/i);
      if (scoreMatch) {
        metrics.score = parseFloat(scoreMatch[1]);
      }
      
      // Look for install counts
      const installMatch = html.match(/(\d+(?:,\d{3})*)\s*(?:installs?|downloads?)/i);
      if (installMatch) {
        metrics.installs = installMatch[1].replace(/,/g, '');
      }
      
      // Look for views
      const viewMatch = html.match(/(\d+(?:,\d{3})*)\s*(?:views?|visitors?)/i);
      if (viewMatch) {
        metrics.views = viewMatch[1].replace(/,/g, '');
      }
      break;
      
    case 'smithery':
      // Extract install counts from Smithery
      const smitheryInstallMatch = html.match(/install[s\s](\d+(?:,\d{3})*)/i);
      if (smitheryInstallMatch) {
        metrics.installs = smitheryInstallMatch[1].replace(/,/g, '');
      }
      
      // Look for download counts
      const downloadMatch = html.match(/download[s\s](\d+(?:,\d{3})*)/i);
      if (downloadMatch) {
        metrics.downloads = downloadMatch[1].replace(/,/g, '');
      }
      break;
  }
  
  return metrics;
}

// Main function
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    Ground Truth MCP - Platform Usage Report Generator         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  const args = process.argv.slice(2);
  const exportIndex = args.indexOf('--export');
  const exportFile = exportIndex !== -1 && args[exportIndex + 1] ? args[exportIndex + 1] : null;
  
  const report = {
    timestamp: new Date().toISOString(),
    platforms: {},
    recommendations: []
  };
  
  // Check Glama
  logInfo('🎯 Fetching Glama usage data...');
  const glamaUrl = 'https://glama.ai/mcp/servers/anish632/ground-truth-mcp';
  const glamaResponse = await fetchUrl(glamaUrl);
  
  if (glamaResponse.status === 200) {
    report.platforms.glama = {
      accessible: true,
      url: glamaUrl,
      metrics: extractMetrics(glamaResponse.text, 'glama')
    };
    
    console.log('  ✅ Glama profile accessible');
    if (report.platforms.glama.metrics.score) {
      console.log(`     📊 Score: ${report.platforms.glama.metrics.score}`);
    }
    if (report.platforms.glama.metrics.installs) {
      console.log(`     💾 Installs: ${report.platforms.glama.metrics.installs}`);
    }
    if (report.platforms.glama.metrics.views) {
      console.log(`     👁️  Views: ${report.platforms.glama.metrics.views}`);
    }
    
    report.recommendations.push(
      '✅ Glama profile is active and discoverable by AI agents',
      '📈 Monitor Glama score for search visibility in the registry'
    );
  } else {
    report.platforms.glama = {
      accessible: false,
      url: glamaUrl,
      error: glamaResponse.error || `HTTP ${glamaResponse.status}`
    };
    logWarning('❌ Glama profile not accessible');
    report.recommendations.push('⚠️  Investigate Glama profile accessibility');
  }
  
  console.log('');
  
  // Check Smithery
  logInfo('🔧 Fetching Smithery usage data...');
  const smitheryUrl = 'https://smithery.ai/servers/anish632/ground-truth';
  const smitheryResponse = await fetchUrl(smitheryUrl);
  
  if (smitheryResponse.status === 200) {
    report.platforms.smithery = {
      accessible: true,
      url: smitheryUrl,
      metrics: extractMetrics(smitheryResponse.text, 'smithery')
    };
    
    console.log('  ✅ Smithery page accessible');
    if (report.platforms.smithery.metrics.installs) {
      console.log(`     💾 Installs: ${report.platforms.smithery.metrics.installs}`);
    }
    if (report.platforms.smithery.metrics.downloads) {
      console.log(`     📥 Downloads: ${report.platforms.smithery.metrics.downloads}`);
    }
    
    report.recommendations.push(
      '✅ Smithery page is active and supports Install button flow',
      '🔧 Use Smithery CLI for updates: smithery mcp publish'
    );
  } else {
    report.platforms.smithery = {
      accessible: false,
      url: smitheryUrl,
      error: smitheryResponse.error || `HTTP ${smitheryResponse.status}`
    };
    logWarning('❌ Smithery page not accessible');
    report.recommendations.push('⚠️  Investigate Smithery page accessibility');
  }
  
  console.log('');
  
  // Check Xpay upstream
  logInfo('💳 Checking Xpay upstream server...');
  const xpayUrl = 'https://ground-truth-mcp-xpay.anishdasmail.workers.dev';
  const xpayResponse = await fetchUrl(xpayUrl);
  
  if (xpayResponse.status === 200) {
    report.platforms.xpay = {
      accessible: true,
      url: xpayUrl,
      status: 'Active'
    };
    console.log('  ✅ Xpay upstream server is active');
    report.recommendations.push(
      '✅ Xpay upstream is available for pay-per-use scenarios',
      '💰 Configure xpay proxy for clients without native x402 support'
    );
  } else {
    report.platforms.xpay = {
      accessible: false,
      url: xpayUrl,
      status: xpayResponse.status
    };
    logWarning('❌ Xpay upstream server not accessible');
    report.recommendations.push('⚠️  Investigate Xpay upstream server status');
  }
  
  console.log('');
  
  // Check main server
  logInfo('🏠 Checking main Cloudflare Workers server...');
  const mainResponse = await fetchUrl(MAIN_SERVER);
  
  if (mainResponse.status === 200) {
    report.platforms.main = {
      accessible: true,
      url: MAIN_SERVER,
      status: 'Active'
    };
    console.log('  ✅ Main server is active');
    report.recommendations.push(
      '✅ Main Ground Truth MCP server is operational',
      '🔗 Use main server URL for direct MCP connections'
    );
  } else {
    report.platforms.main = {
      accessible: false,
      url: MAIN_SERVER,
      status: mainResponse.status
    };
    logWarning('❌ Main server not accessible');
    report.recommendations.push('⚠️  Investigate main server status');
  }
  
  console.log('');
  
  // Internal usage data structure
  logInfo('💾 Cloudflare KV Usage Tracking Structure');
  report.internalUsage = {
    storage: 'Cloudflare KV (API_KEYS namespace)',
    keyPattern: 'usage:{subjectType}:{month}:{subjectId}',
    subjectTypes: ['free', 'free_verify_claim', 'pro'],
    valueStructure: {
      month: 'YYYY-MM format',
      subjectType: 'string',
      subjectId: 'hashed identifier',
      total: 'total requests count',
      byTool: 'per-tool usage breakdown',
      updatedAt: 'ISO timestamp'
    },
    quotas: {
      free: { limit: 100, period: 'monthly' },
      verify_claim_free: { limit: 5, period: 'monthly' },
      starter: { limit: 2500, period: 'monthly', price: '$5/month' },
      team: { limit: 5000, period: 'monthly', price: '$9/month' }
    }
  };
  
  console.log('  🗃️  Usage data stored in Cloudflare KV');
  console.log('  📊 Structure: usage:{subjectType}:{month}:{subjectId}');
  console.log('  🔑 Key types: free (100/month), pro (5000/month)');
  console.log('  📈 Includes per-tool breakdown');
  
  console.log('');
  
  // Usage tracking recommendations
  logInfo('📈 Usage Tracking & Analytics Recommendations');
  
  const trackingRecommendations = [
    '🔧 Set up Cloudflare Analytics for main Worker deployment',
    '📊 Monitor KV namespace usage with Cloudflare API',
    '💳 Track xpay upstream usage separately for pay-per-use analytics',
    '🎯 Use Glama and Smithery built-in analytics for marketplace performance',
    '📈 Consider implementing custom usage endpoint for business intelligence',
    '🔐 Secure usage data with proper authentication for admin access'
  ];
  
  trackingRecommendations.forEach(rec => {
    console.log(`  ${rec}`);
    report.recommendations.push(rec);
  });
  
  console.log('');
  
  // Direct access methods
  logInfo('🛠️  How to Access Detailed Usage Data');
  
  const accessMethods = [
    {
      platform: 'Cloudflare KV (Production)',
      method: 'Use Cloudflare API with API_KEYS namespace',
      command: 'curl -X GET "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/storage/kv/namespaces/API_KEYS_NAMESPACE_ID/values/usage:pro:YYYY-MM:HASH" \\\n  -H "Authorization: Bearer CF_API_TOKEN"'
    },
    {
      platform: 'Local Development',
      method: 'Query SQLite database directly',
      command: 'sqlite3 development.db "SELECT * FROM usage_log;"'
    },
    {
      platform: 'Team API Key Usage',
      method: 'Use MCP with valid API key to check quotas',
      command: 'curl -X POST "' + MAIN_SERVER + '/mcp" \\\n  -H "X-API-Key: gt_live_YOUR_KEY" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_resources"},"id":1}\''
    }
  ];
  
  accessMethods.forEach(method => {
    console.log(`  📌 ${method.platform}:`);
    console.log(`     Method: ${method.method}`);
    console.log(`     Example: ${method.command}`);
    console.log('');
  });
  
  // Business metrics summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 BUSINESS METRICS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  
  // Count accessible platforms
  const accessiblePlatforms = Object.values(report.platforms).filter(p => p.accessible).length;
  const totalPlatforms = Object.keys(report.platforms).length;
  
  console.log(`Platform Availability: ${accessiblePlatforms}/${totalPlatforms} platforms active`);
  
  if (report.platforms.glama.metrics?.score) {
    console.log(`Glama Score: ${report.platforms.glama.metrics.score}/100`);
  }
  if (report.platforms.glama.metrics?.installs) {
    console.log(`Glama Installs: ${report.platforms.glama.metrics.installs}`);
  }
  if (report.platforms.smithery.metrics?.installs) {
    console.log(`Smithery Installs: ${report.platforms.smithery.metrics.installs}`);
  }
  
  console.log('');
  console.log('Service Status:');
  console.log(`  Main Server: ${report.platforms.main?.accessible ? '✅ Active' : '❌ Down'}`);
  console.log(`  Xpay Upstream: ${report.platforms.xpay?.accessible ? '✅ Active' : '❌ Down'}`);
  console.log(`  Glama Profile: ${report.platforms.glama?.accessible ? '✅ Active' : '❌ Down'}`);
  console.log(`  Smithery Page: ${report.platforms.smithery?.accessible ? '✅ Active' : '❌ Down'}`);
  
  console.log('');
  console.log('Usage Capacity:');
  console.log('  Free Tier: 100 requests/month per IP');
  console.log('  Starter Plan: 2,500 requests/month ($5/month)');
  console.log('  Team Plan: 5,000 requests/month ($9/month)');
  console.log('  Xpay: Pay-per-use ($0.01-$0.05 per tool call)');
  
  // Export if requested
  if (exportFile) {
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(exportFile, JSON.stringify(report, null, 2));
      logSuccess(`✅ Report exported to: ${exportFile}`);
      console.log('');
    } catch (error) {
      logError(`❌ Failed to export report: ${error.message}`);
    }
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🚀 Next Steps for Detailed Usage Analytics:');
  console.log('');
  console.log('1. 🔐 Get Cloudflare API credentials for KV access');
  console.log('2. 📊 Set up regular usage data collection pipeline');
  console.log('3. 📈 Build dashboard with usage trends and predictions');
  console.log('4. 💰 Monitor revenue from team plans and xpay usage');
  console.log('5. 🎯 Track user acquisition from Glama/Smithery referrals');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

// Run
main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});