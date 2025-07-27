const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');

let py;
let mainWindow;

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const checkServer = async (attempt) => {
      try {
        await axios.get('http://127.0.0.1:8000/docs');
        console.log('Python server is ready!');
        resolve();
      } catch (error) {
        if (attempt < retries) {
          console.log(`Waiting for server... attempt ${attempt}/${retries}`);
          setTimeout(() => checkServer(attempt + 1), 1000);
        } else {
          reject(new Error('Python server failed to start'));
        }
      }
    };
    checkServer(1);
  });
}

async function createWindow() {
  // Start Python API server
  console.log('Starting Python server...');
  py = spawn('python', [path.join(__dirname, 'api_server.py')]);
  
  py.stdout.on('data', (data) => {
    console.log(`Python: ${data}`);
  });
  
  py.stderr.on('data', (data) => {
    console.log(`Python Info: ${data}`);
  });

  py.on('error', (error) => {
    console.error('Failed to start Python process:', error);
  });

  // Wait for the server to be ready
  try {
    await waitForServer();
  } catch (error) {
    console.error('Python server startup failed:', error);
    return;
  }

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load the app
  mainWindow.loadFile('dist/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (py) py.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  if (py) py.kill();
});
