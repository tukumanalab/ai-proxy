// Load environment variables FIRST, before any other imports
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

// Now import everything else
import express, { Request, Response } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import colors from 'colors';
import { db } from './database';
import { ngWordChecker } from './ngWordChecker';

const app = express();
const PORT = process.env.PORT || 3000;
const SAKURA_AI_API = process.env.SAKURA_AI_API || 'https://api.sakura.ai';

// Set up view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Enable JSON parsing with increased limit for large requests
app.use(express.json({ limit: '10mb' }));

// Simple request logger (only for debugging)
// app.use((req, res, next) => {
//   console.log(colors.gray(`${req.method} ${req.path}`));
//   next();
// });

// Request counter for logging
let requestCounter = 0;

// Logging utility
function logSection(title: string, content: any) {
  console.log(colors.cyan(`\n${'='.repeat(60)}`));
  console.log(colors.yellow.bold(title));
  console.log(colors.cyan('='.repeat(60)));
  if (typeof content === 'object') {
    console.log(JSON.stringify(content, null, 2));
  } else {
    console.log(content);
  }
}

// Proxy configuration with monitoring
const proxyMiddleware = createProxyMiddleware({
  target: SAKURA_AI_API,
  changeOrigin: true,
  pathRewrite: {
    '^/proxy': '', // Remove /proxy prefix when forwarding
  },

  onProxyReq: (proxyReq, req: Request, res: Response) => {
    const reqId = ++requestCounter;
    const timestamp = new Date().toISOString();

    // Store request ID for later reference
    (req as any).reqId = reqId;
    (req as any).timestamp = timestamp;

    console.log(colors.cyan(`📤 Request #${reqId}: ${req.method} ${req.path}`))

    // Save request to database
    const dbId = db.insertRequest({
      timestamp,
      method: req.method,
      path: req.path,
      headers: JSON.stringify(req.headers),
      query: JSON.stringify(req.query),
      requestBody: req.body ? JSON.stringify(req.body) : ''
    });

    // Store DB ID for later update
    (req as any).dbId = dbId;

    // Fix request body for proxy
    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },

  onProxyRes: (proxyRes, req: Request, res: Response) => {
    const reqId = (req as any).reqId;
    const timestamp = (req as any).timestamp;
    const dbId = (req as any).dbId;
    const duration = Date.now() - new Date(timestamp).getTime();

    console.log(colors.green(`📥 Response #${reqId}: ${proxyRes.statusCode} (${duration}ms)`));

    // Capture response body
    let responseBody = '';

    proxyRes.on('data', (chunk: Buffer) => {
      responseBody += chunk.toString('utf8');
    });

    proxyRes.on('end', () => {

      // Update database with response
      if (dbId) {
        db.updateResponse(dbId, {
          statusCode: proxyRes.statusCode,
          responseHeaders: JSON.stringify(proxyRes.headers),
          responseBody: responseBody,
          duration
        });
      }
    });
  },

  onError: (err, req: Request, res: Response) => {
    const reqId = (req as any).reqId || 'unknown';
    const dbId = (req as any).dbId;
    const timestamp = (req as any).timestamp;
    const duration = timestamp ? Date.now() - new Date(timestamp).getTime() : 0;

    console.error(colors.red(`\n❌ ERROR on Request #${reqId}:`));
    console.error(colors.red(err.message));
    console.error(err.stack);

    // Update database with error
    if (dbId) {
      db.updateResponse(dbId, {
        error: err.message,
        duration
      });
    }

    res.status(500).json({
      error: 'Proxy Error',
      message: err.message
    });
  }
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    proxy_target: SAKURA_AI_API,
    timestamp: new Date().toISOString()
  });
});

// Dashboard UI routes (root path)
app.get('/', (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const requests = db.getAllRequests(limit, offset);
  const totalCount = db.getTotalCount();
  const totalPages = Math.ceil(totalCount / limit);

  res.render('dashboard', {
    requests,
    currentPage: page,
    totalPages,
    totalCount
  });
});

app.get('/request/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const request = db.getRequestById(id);

  if (!request) {
    res.status(404).send('Request not found');
    return;
  }

  res.render('request-detail', { request });
});

// API endpoint for JSON data
app.get('/api/requests', (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;

  const requests = db.getAllRequests(limit, offset);
  const totalCount = db.getTotalCount();

  res.json({
    requests,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit)
    }
  });
});

// Apply NG word checker and proxy middleware to /proxy path
app.use('/proxy', ngWordChecker.middleware(), proxyMiddleware);

// Start server
app.listen(PORT, () => {
  console.log(colors.rainbow('\n' + '='.repeat(60)));
  console.log(colors.green.bold(`  🚀 Tukumana Proxy Server Started`));
  console.log(colors.rainbow('='.repeat(60)));
  console.log(colors.white(`  📊 Dashboard: http://localhost:${PORT}`));
  console.log(colors.white(`  📍 Proxy:     http://localhost:${PORT}/proxy`));
  console.log(colors.white(`  🎯 Target:    ${SAKURA_AI_API}`));

  const ngWords = ngWordChecker.getNGWords();
  if (ngWords.length > 0) {
    console.log(colors.white(`  🚫 NG Words:  ${ngWords.length} word(s) configured`));
    console.log(colors.gray(`     Words: ${ngWords.join(', ')}`));
  } else {
    console.log(colors.gray(`  🚫 NG Words:  None configured`));
  }

  console.log(colors.rainbow('='.repeat(60) + '\n'));
  console.log(colors.yellow(`  Monitoring all requests to Sakura AI...`));
  console.log(colors.gray(`  Press Ctrl+C to stop\n`));
});
