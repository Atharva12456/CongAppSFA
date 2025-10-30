import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// API endpoint to run research analysis
app.post('/api/research', async (req, res) => {
  const { topic } = req.body;
  
  if (!topic) {
    return res.status(400).json({ 
      success: false, 
      error: 'Topic is required' 
    });
  }

  console.log(`[SERVER] Starting research analysis for topic: "${topic}"`);
  
  // Spawn Python process
  const pythonScript = path.join(__dirname, 'CongApp.py');
  const pythonProcess = spawn('python', [pythonScript, '--topic', topic, '--json'], {
    env: {
      ...process.env, // Pass all environment variables including SEMANTIC_SCHOLAR_API_KEY
      PYTHONIOENCODING: 'utf-8' // Ensure proper encoding
    }
  });

  let stdoutData = '';
  let stderrData = '';
  let hasResponded = false;

  // Set timeout (5 minutes)
  const timeout = setTimeout(() => {
    if (!hasResponded) {
      pythonProcess.kill();
      hasResponded = true;
      console.error('[SERVER] Request timed out after 5 minutes');
      res.status(504).json({ 
        success: false, 
        error: 'Request timed out. The analysis is taking too long.' 
      });
    }
  }, 5 * 60 * 1000); // 5 minutes

  // Capture stdout (JSON output)
  pythonProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  // Capture stderr (progress logs)
  pythonProcess.stderr.on('data', (data) => {
    const message = data.toString();
    stderrData += message;
    // Log progress to server console
    process.stderr.write(message);
  });

  // Handle process completion
  pythonProcess.on('close', (code) => {
    clearTimeout(timeout);
    
    if (hasResponded) {
      return; // Already sent timeout response
    }
    
    hasResponded = true;

    if (code !== 0) {
      console.error(`[SERVER] Python process exited with code ${code}`);
      console.error('[SERVER] Error output:', stderrData);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to analyze research papers',
        details: stderrData 
      });
    }

    try {
      // Parse JSON output from stdout
      const result = JSON.parse(stdoutData);
      console.log(`[SERVER] Analysis complete. Found ${result.papers.length} papers.`);
      res.json(result);
    } catch (error) {
      console.error('[SERVER] Failed to parse Python output:', error);
      console.error('[SERVER] Raw stdout:', stdoutData);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to parse analysis results',
        details: error.message 
      });
    }
  });

  // Handle process errors
  pythonProcess.on('error', (error) => {
    clearTimeout(timeout);
    
    if (hasResponded) {
      return;
    }
    
    hasResponded = true;
    console.error('[SERVER] Failed to start Python process:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to start analysis process',
      details: error.message 
    });
  });
});

// Health check endpoint
// API endpoint to get related papers for a given paper
app.post('/api/related-papers', async (req, res) => {
  const { paperId, title, abstract, excludePaperIds } = req.body;
  
  if (!paperId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Paper ID is required' 
    });
  }

  console.log(`[SERVER] Finding related papers for: "${title || paperId}"`);
  if (excludePaperIds && excludePaperIds.length > 0) {
    console.log(`[SERVER] Excluding ${excludePaperIds.length} existing papers`);
  }
  
  // Spawn Python process
  const pythonScript = path.join(__dirname, 'CongApp.py');
  const args = ['--paper-id', paperId, '--json'];
  if (title) args.push('--title', title);
  if (abstract) args.push('--abstract', abstract);
  if (excludePaperIds && excludePaperIds.length > 0) {
    args.push('--exclude-ids', JSON.stringify(excludePaperIds));
  }
  
  const pythonProcess = spawn('python', [pythonScript, ...args], {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8'
    }
  });

  let stdoutData = '';
  let stderrData = '';
  let hasResponded = false;

  // Set timeout (2 minutes for related papers - faster than full research)
  const timeout = setTimeout(() => {
    if (!hasResponded) {
      pythonProcess.kill();
      hasResponded = true;
      console.error('[SERVER] Related papers request timed out after 2 minutes');
      res.status(504).json({ 
        success: false, 
        error: 'Request timed out. The analysis is taking too long.' 
      });
    }
  }, 2 * 60 * 1000); // 2 minutes

  pythonProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  pythonProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
    console.error(`[PYTHON_ERR] ${data.toString().trim()}`);
  });

  pythonProcess.on('close', (code) => {
    clearTimeout(timeout);
    if (hasResponded) return;
    hasResponded = true;

    console.log(`[SERVER] Python process exited with code ${code}`);
    
    if (code !== 0) {
      console.error(`[SERVER] Python error for paper: "${title || paperId}"`);
      console.error(`[SERVER] Error output:\n${stderrData}`);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to analyze related papers', 
        details: stderrData 
      });
    }

    try {
      const result = JSON.parse(stdoutData);
      res.json({ success: true, ...result });
    } catch (e) {
      console.error(`[SERVER] Failed to parse Python output:`, e);
      console.error(`[SERVER] Raw output:\n${stdoutData}`);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to parse Python script output', 
        details: stdoutData 
      });
    }
  });

  pythonProcess.on('error', (err) => {
    clearTimeout(timeout);
    if (hasResponded) return;
    hasResponded = true;
    
    console.error(`[SERVER] Failed to start Python process:`, err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to start Python script', 
      details: err.message 
    });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Backend server running on http://localhost:${PORT}`);
  console.log(`[SERVER] Ready to process research requests`);
});


