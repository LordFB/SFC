/**
 * Shop API Server
 * Runs on port 5174 to handle shop API requests
 */

import http from 'http';
import { shopDb } from './shop-db.js';

const PORT = 5174;

// CORS headers for development
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  
  // Set headers
  res.setHeader('Content-Type', 'application/json');
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  
  try {
    if (req.method === 'POST') {
      const body = await parseBody(req);
      
      // Products API
      if (path === '/shop/api/products') {
        const { action } = body;
        let result;
        
        switch (action) {
          case 'list':
            result = {
              products: shopDb.getAllProducts(),
              categories: shopDb.getCategories()
            };
            break;
          case 'get':
            result = {
              product: shopDb.getProductById(body.id)
            };
            break;
          case 'search':
            result = {
              products: shopDb.searchProducts(body.term || '')
            };
            break;
          case 'category':
            result = {
              products: shopDb.getProductsByCategory(body.category)
            };
            break;
          default:
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid action' }));
            return;
        }
        
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }
      
      // Cart API
      if (path === '/shop/api/cart') {
        const { action, sessionId } = body;
        
        if (!sessionId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Session ID required' }));
          return;
        }
        
        let result;
        
        switch (action) {
          case 'get':
            result = shopDb.getCart(sessionId);
            break;
          case 'add':
            if (!body.productId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Product ID required' }));
              return;
            }
            result = shopDb.addToCart(sessionId, body.productId, body.quantity || 1);
            break;
          case 'update':
            if (!body.productId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Product ID required' }));
              return;
            }
            result = shopDb.updateCartQuantity(sessionId, body.productId, body.quantity);
            break;
          case 'remove':
            if (!body.productId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Product ID required' }));
              return;
            }
            result = shopDb.removeFromCart(sessionId, body.productId);
            break;
          case 'clear':
            result = shopDb.clearCart(sessionId);
            break;
          default:
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid action' }));
            return;
        }
        
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }
      
      // Orders API
      if (path === '/shop/api/orders') {
        const { action, sessionId } = body;
        let result;
        
        switch (action) {
          case 'create':
            if (!sessionId || !body.customerInfo) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Session ID and customer info required' }));
              return;
            }
            const { name, email, address } = body.customerInfo;
            if (!name || !email || !address) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Name, email, and address are required' }));
              return;
            }
            result = {
              order: shopDb.createOrder(sessionId, body.customerInfo)
            };
            break;
          case 'get':
            if (!body.orderId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Order ID required' }));
              return;
            }
            result = {
              order: shopDb.getOrderById(body.orderId)
            };
            break;
          case 'list':
            if (!sessionId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Session ID required' }));
              return;
            }
            result = {
              orders: shopDb.getOrdersBySession(sessionId)
            };
            break;
          default:
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid action' }));
            return;
        }
        
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }
    }
    
    // Not found
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    
  } catch (err) {
    console.error('[shop-api] Error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  Shop API Server                          ║
║  Running on http://localhost:${PORT}        ║
╚═══════════════════════════════════════════╝
  `);
});
