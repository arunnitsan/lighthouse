import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
const app = express();
const port = parseInt(process.env.PORT || '3400', 10);
// Ensure reports directory exists
const reportsDir = join(process.cwd(), 'reports');
if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir);
}
// Middleware
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'"],
        },
    },
}));
app.use(express.json());
app.use(express.static('public'));
// Root route
app.get('/', (_req, res) => {
    res.json({
        message: 'Welcome to Lighthouse API',
        endpoints: {
            '/nsa-audit?url={weburl}': 'GET - Run Lighthouse nsa-audit on a URL',
            '/health': 'GET - Check API health status',
            '/viewer': 'GET - View Lighthouse reports'
        }
    });
});
// Routes
app.get('/nsa-audit', async (req, res) => {
    try {
        const url = req.query.url;
        const locale = req.query.locale || 'en';
        console.log('Request query:', req.query);
        console.log('Raw URL from query:', url);
        if (!url) {
            return res.status(400).json({
                error: 'URL is required as a query parameter. Example: /nsa-audit?url=https://example.com'
            });
        }
        const decodedUrl = decodeURIComponent(url.toString());
        console.log('Decoded URL:', decodedUrl);
        try {
            new URL(decodedUrl);
        }
        catch (e) {
            return res.status(400).json({
                error: 'Invalid URL format. Please provide a valid URL starting with http:// or https://'
            });
        }
        // Launch Chrome with additional flags for stability
        const chrome = await launch({
            chromeFlags: [
                '--headless=new',
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--ignore-certificate-errors',
                '--allow-insecure-localhost',
                '--allow-running-insecure-content',
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--mute-audio',
                '--no-default-browser-check',
                '--no-first-run',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--password-store=basic'
            ],
            logLevel: 'info',
            connectionPollInterval: 500,
            maxConnectionRetries: 10,
            chromePath: process.platform === 'darwin'
                ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                : undefined
        });
        console.log('Chrome launched successfully on port:', chrome.port);
        // Minimal, standard Lighthouse config for mobile
        const options = {
            logLevel: 'info',
            output: 'json',
            port: chrome.port,
            onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
            locale: locale,
            formFactor: 'mobile',
            screenEmulation: {
                mobile: true,
                width: 375,
                height: 667,
                deviceScaleFactor: 2,
                disabled: false
            },
            settings: {
                onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
                formFactor: 'mobile',
                screenEmulation: {
                    mobile: true,
                    width: 375,
                    height: 667,
                    deviceScaleFactor: 2,
                    disabled: false
                }
            }
        };
        console.log('Starting Lighthouse audit with options:', JSON.stringify(options, null, 2));
        try {
            // Wait for Chrome to be ready
            await new Promise(resolve => setTimeout(resolve, 10000));
            console.log('Starting Lighthouse audit...');
            const results = await lighthouse(decodedUrl, options);
            console.log('Lighthouse audit completed');
            // More detailed validation of results
            if (!results) {
                console.error('Lighthouse returned null results object');
                throw new Error('Lighthouse returned null results object');
            }
            if (!results.lhr) {
                console.error('Lighthouse results missing lhr property');
                throw new Error('Lighthouse results missing lhr property');
            }
            // Validate essential properties
            const requiredProperties = ['finalUrl', 'fetchTime', 'categories', 'audits'];
            for (const prop of requiredProperties) {
                if (!results.lhr[prop]) {
                    console.error(`Lighthouse results missing required property: ${prop}`);
                    throw new Error(`Lighthouse results missing required property: ${prop}`);
                }
            }
            console.log('Lighthouse results validation passed');
            console.log('Results structure:', {
                finalUrl: results.lhr.finalUrl,
                fetchTime: results.lhr.fetchTime,
                categories: Object.keys(results.lhr.categories),
                auditCount: Object.keys(results.lhr.audits).length
            });
            // Save complete report
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const reportPath = join(reportsDir, `lighthouse-report-${timestamp}.json`);
            // Ensure the report directory exists
            if (!existsSync(reportsDir)) {
                mkdirSync(reportsDir, { recursive: true });
            }
            // Save the report with proper error handling
            try {
                writeFileSync(reportPath, JSON.stringify(results.lhr, null, 2));
                console.log('Report saved successfully to:', reportPath);
            }
            catch (writeError) {
                console.error('Error saving report:', writeError);
                throw new Error(`Failed to save report: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`);
            }
            // Return complete Lighthouse data
            res.json({
                success: true,
                url: decodedUrl,
                timestamp: new Date().toISOString(),
                locale: locale,
                lighthouseResult: results.lhr,
                reportPath: `/reports/lighthouse-report-${timestamp}.json`
            });
        }
        catch (error) {
            console.error('Lighthouse audit failed:', error);
            // Improved error logging
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred',
                details: error && typeof error === 'object' ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : error
            });
            return;
        }
        finally {
            // Ensure Chrome is killed even if Lighthouse fails
            try {
                await chrome.kill();
                console.log('Chrome process terminated');
            }
            catch (killError) {
                console.error('Error killing Chrome:', killError);
            }
        }
    }
    catch (error) {
        console.error('Lighthouse audit failed:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});
// Health check endpoint
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// Viewer endpoint
app.get('/viewer', (_req, res) => {
    const viewerHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Lighthouse Viewer</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 20px;
          background: #f5f5f5;
        }
        .container {
          max-width: 100%;
          margin: 0 auto;
          background: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
          color: #333;
          margin-bottom: 20px;
        }
        .reports {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
        }
        .report-card {
          background: #fff;
          border: 1px solid #ddd;
          border-radius: 4px;
          padding: 15px;
          cursor: pointer;
          transition: transform 0.2s;
          position: relative;
        }
        .report-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 8px rgba(0,0,0,0.1);
        }
        .report-card .url {
          color: #2196F3;
          text-decoration: none;
          word-break: break-all;
          display: block;
          margin-bottom: 10px;
          font-weight: bold;
        }
        .report-card .url:hover {
          text-decoration: underline;
        }
        .report-card .timestamp {
          color: #666;
          font-size: 0.9em;
          margin-bottom: 15px;
        }
        .report-card .metrics {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
          margin-top: 10px;
        }
        .report-card .metric {
          background: #f8f9fa;
          padding: 8px;
          border-radius: 4px;
          text-align: center;
        }
        .report-card .metric-value {
          font-size: 1.2em;
          font-weight: bold;
        }
        .report-card .metric-value.good {
          color: #4CAF50;
        }
        .report-card .metric-value.warning {
          color: #FFC107;
        }
        .report-card .metric-value.poor {
          color: #F44336;
        }
        .report-card .metric-label {
          text-transform: capitalize;
          font-size: 0.9em;
          color: #666;
        }
        .loading {
          text-align: center;
          padding: 20px;
          color: #666;
        }
        .error {
          color: #F44336;
          padding: 20px;
          text-align: center;
          background: #FFEBEE;
          border-radius: 4px;
          margin: 20px 0;
        }
        .retry-button {
          background: #2196F3;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 10px;
        }
        .retry-button:hover {
          background: #1976D2;
        }
        .empty-state {
          text-align: center;
          padding: 40px 20px;
          color: #666;
          background: #f8f9fa;
          border-radius: 4px;
          margin: 20px 0;
        }
        .empty-state h2 {
          color: #333;
          margin-bottom: 10px;
        }
        .empty-state p {
          margin-bottom: 20px;
        }
        .run-audit-button {
          background: #4CAF50;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1.1em;
          text-decoration: none;
          display: inline-block;
        }
        .run-audit-button:hover {
          background: #388E3C;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Lighthouse Reports</h1>
        <div id="reports" class="reports">
          <div class="loading">Loading reports...</div>
        </div>
      </div>
      <script>
        function formatDate(dateString) {
          try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
              return 'Invalid Date';
            }
            return date.toLocaleString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          } catch (error) {
            return 'Invalid Date';
          }
        }

        function formatUrl(url) {
          try {
            const urlObj = new URL(url);
            return urlObj.hostname + urlObj.pathname;
          } catch (error) {
            return url || 'Unknown URL';
          }
        }

        function getScoreColor(score) {
          if (score >= 0.9) return 'good';
          if (score >= 0.5) return 'warning';
          return 'poor';
        }

        function showError(message) {
          const reportsContainer = document.getElementById('reports');
          reportsContainer.innerHTML = \`
            <div class="error">
              \${message}
              <br>
              <button class="retry-button" onclick="loadReports()">Retry</button>
            </div>
          \`;
        }

        function showEmptyState() {
          const reportsContainer = document.getElementById('reports');
          reportsContainer.innerHTML = \`
            <div class="empty-state">
              <h2>No Reports Found</h2>
              <p>Run your first Lighthouse audit to see results here.</p>
              <a href="/nsa-audit?url=https://example.com" class="run-audit-button">Run First Audit</a>
            </div>
          \`;
        }

        async function loadReports() {
          const reportsContainer = document.getElementById('reports');
          reportsContainer.innerHTML = '<div class="loading">Loading reports...</div>';
          
          try {
            const protocol = window.location.protocol;
            const host = window.location.host;
            const baseUrl = \`\${protocol}//\${host}\`;

            const response = await fetch(\`\${baseUrl}/reports\`);
            if (!response.ok) {
              throw new Error(\`HTTP error! status: \${response.status}\`);
            }
            const reports = await response.json();
            
            if (reports.length === 0) {
              showEmptyState();
              return;
            }
            
            reportsContainer.innerHTML = '';
            
            for (const report of reports) {
              try {
                const reportResponse = await fetch(\`\${baseUrl}/reports/\${report}\`);
                if (!reportResponse.ok) {
                  throw new Error(\`HTTP error! status: \${reportResponse.status}\`);
                }
                const reportData = await reportResponse.json();
                
                const card = document.createElement('div');
                card.className = 'report-card';
                card.onclick = () => window.location.href = \`\${baseUrl}/reports/\${report}\`;
                
                // Extract data from Lighthouse report structure
                const url = reportData.finalUrl || reportData.url || '';
                const timestamp = reportData.fetchTime || reportData.timestamp || '';
                const categories = reportData.categories || {};
                
                card.innerHTML = \`
                  <a href="\${url}" target="_blank" class="url" onclick="event.stopPropagation()">\${formatUrl(url)}</a>
                  <div class="timestamp">\${formatDate(timestamp)}</div>
                  <div class="metrics">
                    \${Object.entries(categories).map(([key, value]) => \`
                      <div class="metric">
                        <div class="metric-value \${getScoreColor(value.score)}">\${Math.round(value.score * 100)}</div>
                        <div class="metric-label">\${key}</div>
                      </div>
                    \`).join('')}
                  </div>
                \`;
                
                reportsContainer.appendChild(card);
              } catch (error) {
                console.error(\`Error loading report \${report}:\`, error);
              }
            }
          } catch (error) {
            console.error('Error loading reports:', error);
            showError(\`Failed to load reports: \${error.message}\`);
          }
        }
        
        loadReports();
      </script>
    </body>
    </html>
  `;
    res.send(viewerHtml);
});
// List reports endpoint
app.get('/reports', (_req, res) => {
    try {
        // Ensure reports directory exists
        if (!existsSync(reportsDir)) {
            mkdirSync(reportsDir, { recursive: true });
        }
        // Read directory and filter JSON files
        const files = readdirSync(reportsDir)
            .filter(file => file.endsWith('.json'))
            .sort((a, b) => {
            // Sort by timestamp in filename (newest first)
            const timeA = a.split('-').pop()?.replace('.json', '') || '';
            const timeB = b.split('-').pop()?.replace('.json', '') || '';
            return timeB.localeCompare(timeA);
        });
        console.log('Found reports:', files);
        res.json(files);
    }
    catch (error) {
        console.error('Error listing reports:', error);
        res.status(500).json({ error: 'Failed to list reports' });
    }
});
// Get report endpoint
app.get('/reports/:filename', (req, res) => {
    try {
        const reportPath = join(reportsDir, req.params.filename);
        console.log('Reading report:', reportPath);
        if (!existsSync(reportPath)) {
            console.error('Report not found:', reportPath);
            return res.status(404).json({ error: 'Report not found' });
        }
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        console.log('Report loaded successfully');
        res.json(report);
    }
    catch (error) {
        console.error('Error reading report:', error);
        res.status(500).json({ error: 'Failed to read report' });
    }
});
// Start server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
//# sourceMappingURL=index.js.map