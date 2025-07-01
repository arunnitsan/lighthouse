import { test as base, expect } from '@playwright/test';
import { playAudit } from 'playwright-lighthouse';
import { spawn } from 'child_process';
import { join } from 'path';
import { launch } from 'chrome-launcher';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'net';
import waitOn from 'wait-on';

// Explicitly set Chrome path for Mac (adjust if needed)
process.env.CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const execAsync = promisify(exec);
const BASE_PORT = 3400;
let serverProcess: any;
let chrome: any;
let serverPort: number;

async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
    server.listen(startPort, () => {
      const { port } = server.address() as any;
      server.close(() => resolve(port));
    });
  });
}

async function killProcessOnPort(port: number) {
  try {
    const { stdout } = await execAsync(`lsof -i :${port} -t`);
    if (stdout) {
      await execAsync(`kill -9 ${stdout.trim()}`);
      // Wait for process to be killed
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    // Ignore errors if no process is found
  }
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (error) {
      // Ignore connection errors and retry
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function startServer() {
  // Find an available port
  serverPort = await findAvailablePort(BASE_PORT);
  console.log(`Starting server on port ${serverPort}`);
  
  // Kill any existing process on the port
  await killProcessOnPort(serverPort);

  // Start the server with explicit PORT environment variable
  serverProcess = spawn('node', ['dist/index.js'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, PORT: serverPort.toString() }
  });

  // Handle server process errors
  serverProcess.on('error', (error: Error) => {
    console.error('Server process error:', error);
    throw error;
  });

  // Handle server process exit
  serverProcess.on('exit', (code: number | null) => {
    if (code === null) {
      console.log('Server process was killed');
      return;
    }
    if (code !== 0) {
      console.error(`Server process exited with code ${code}`);
      throw new Error(`Server process exited with code ${code}`);
    }
  });

  // Wait for server to be ready
  const isReady = await waitForServer(serverPort);
  if (!isReady) {
    throw new Error(`Server failed to start on port ${serverPort}`);
  }
  console.log(`Server is ready on port ${serverPort}`);
}

async function startChrome() {
  console.log('Starting Chrome...');
  try {
    chrome = await launch({
      chromeFlags: [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--remote-debugging-port=0',
        '--remote-debugging-address=0.0.0.0'
      ],
      port: 0
    });

    // Log Chrome process output for debugging
    if (chrome.process) {
      chrome.process.stdout?.on('data', (data) => {
        console.log(`[Chrome stdout]: ${data}`);
      });
      chrome.process.stderr?.on('data', (data) => {
        console.error(`[Chrome stderr]: ${data}`);
      });
    }

    console.log(`Chrome started on port ${chrome.port}`);

    // Wait for Chrome to be ready (increased to 60s)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Chrome startup timeout'));
      }, 60000);

      const checkChrome = async () => {
        try {
          const response = await fetch(`http://localhost:${chrome.port}/json/version`);
          if (response.ok) {
            clearTimeout(timeout);
            console.log('Chrome is ready');
            resolve(true);
          }
        } catch (error) {
          setTimeout(checkChrome, 1000);
        }
      };

      checkChrome();
    });
    // Add a delay to ensure Chrome is fully ready
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    console.error('Error starting Chrome:', err);
    throw err;
  }
}

// Configure test to run sequentially
const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
  }
});

// Run tests sequentially
test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  try {
    console.log('Starting server...');
    await startServer();
    console.log('Server started successfully');

    console.log('Starting Chrome...');
    await startChrome();
    console.log('Chrome started successfully');
  } catch (error) {
    console.error('Setup failed:', error);
    // Clean up any partially started processes
    if (chrome) {
      await chrome.kill();
    }
    if (serverProcess) {
      serverProcess.kill();
      await killProcessOnPort(serverPort);
    }
    throw error;
  }
});

test.afterEach(async () => {
  console.log('Cleaning up...');
  try {
    if (chrome) {
      try {
        await chrome.kill();
        console.log('Chrome killed');
      } catch (error) {
        console.error('Error killing Chrome:', error);
      }
    }
    if (serverProcess) {
      try {
        serverProcess.kill();
        await killProcessOnPort(serverPort);
        console.log('Server killed');
      } catch (error) {
        console.error('Error killing server:', error);
      }
    }
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
});

test.describe('Lighthouse Audit Tests', () => {
  test('should perform lighthouse audit on the health endpoint', async ({ page }) => {
    const url = `http://localhost:${serverPort}/health`;
    console.log(`Testing health endpoint: ${url}`);
    console.log('Server running on:', serverPort);
    console.log('Chrome debugging port:', chrome.port);
    
    // Wait for the server health endpoint to be available
    await waitOn({ resources: [url] });
    
    // Add longer timeout and wait for network idle
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
    
    // Wait for any dynamic content to load
    await page.waitForTimeout(5000);
    
    // Robust error logging for playAudit
    try {
      await playAudit({
        page,
        port: chrome.port,
        thresholds: {
          performance: 50,
          accessibility: 50,
          'best-practices': 50,
          seo: 50
        },
        config: {
          settings: {
            maxWaitForLoad: 60000,
            maxWaitForFcp: 60000,
            disableStorageReset: true,
            skipAboutBlank: true,
            formFactor: 'desktop',
            screenEmulation: {
              mobile: false,
              width: 1350,
              height: 940,
              deviceScaleFactor: 1,
              disabled: false
            },
            disableFullPageScreenshot: true,
            skipAudits: ['bf-cache'],
            onlyAudits: null
          }
        }
      });
    } catch (err) {
      console.error('Lighthouse/playAudit error:', err);
      throw err;
    }
  });

  test('should perform lighthouse audit on the nsa-audit endpoint', async ({ page }) => {
    const url = `http://localhost:${serverPort}/nsa-audit?url=https://example.com`;
    console.log(`Testing nsa-audit endpoint: ${url}`);
    console.log('Server running on:', serverPort);
    console.log('Chrome debugging port:', chrome.port);
    
    // Wait for the server health endpoint to be available
    await waitOn({ resources: [`http://localhost:${serverPort}/health`] });
    
    // Add longer timeout and wait for network idle
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });
    
    // Wait for any dynamic content to load
    await page.waitForTimeout(5000);
    
    // Robust error logging for playAudit
    try {
      await playAudit({
        page,
        port: chrome.port,
        thresholds: {
          performance: 50
        },
        config: {
          settings: {
            onlyCategories: ['performance'],
            maxWaitForLoad: 60000,
            maxWaitForFcp: 60000,
            disableStorageReset: true,
            skipAboutBlank: true,
            formFactor: 'desktop',
            screenEmulation: {
              mobile: false,
              width: 1350,
              height: 940,
              deviceScaleFactor: 1,
              disabled: false
            },
            disableFullPageScreenshot: true,
            skipAudits: ['bf-cache'],
            onlyAudits: null
          }
        }
      });
    } catch (err) {
      console.error('Lighthouse/playAudit error:', err);
      throw err;
    }
  });
}); 