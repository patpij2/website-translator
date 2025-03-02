const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const path = require('path');
const { URL } = require('url');
const urlParser = require('url');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const LIBRE_TRANSLATE_API = 'http://localhost:5050';

// Initialize database
const db = new Database(path.join(__dirname, 'translations.db'));

// Drop existing tables and recreate them
db.exec(`
  DROP TABLE IF EXISTS translations;
  DROP TABLE IF EXISTS websites;

  CREATE TABLE websites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    original_text TEXT NOT NULL,
    translated_text TEXT,
    language TEXT NOT NULL,
    path TEXT NOT NULL,
    element_type TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (website_id) REFERENCES websites (id)
  );
`);

// Update the prepared statements
const insertWebsite = db.prepare(`
  INSERT INTO websites (domain, created_at) 
  VALUES (?, datetime('now'))
`);

const findWebsite = db.prepare('SELECT id, domain FROM websites WHERE domain = ?');

const insertTranslation = db.prepare(`
  INSERT INTO translations (
    website_id, 
    original_text, 
    translated_text, 
    language, 
    path, 
    element_type
  ) VALUES (?, ?, ?, ?, ?, ?)
`);

const findTranslations = db.prepare(`
  SELECT * FROM translations 
  WHERE website_id = ? AND language = ? AND path = ?
`);

// Add this near other SQL statements at the top
const getTranslation = db.prepare(`
  SELECT t.translated_text 
  FROM translations t
  JOIN websites w ON t.website_id = w.id
  WHERE w.domain = ?
  AND t.original_text = ? 
  AND t.language = ?
`);

// Function to extract domain from URL
function getDomain(url) {
  return new URL(url).hostname;
}

// Function to translate text
async function translateText(text, targetLanguage) {
  try {
    const response = await axios.post(`${LIBRE_TRANSLATE_API}/translate`, {
      q: text,
      source: 'auto',
      target: targetLanguage,
      format: 'text'
    });
    return response.data.translatedText;
  } catch (error) {
    console.error('Translation error:', error);
    return text;
  }
}

// Helper function to fix URLs in CSS content
async function fixCssUrls(cssContent, domain, baseUrl) {
  return cssContent.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, url) => {
    if (url.startsWith('data:')) return `url('${url}')`;
    if (url.startsWith('http')) return `url('${url}')`;
    try {
      const absoluteUrl = new URL(url, baseUrl).href;
      return `url('${absoluteUrl}')`;
    } catch (e) {
      console.log('Invalid CSS URL:', url);
      return match;
    }
  });
}

// Common function to handle both root and sub-paths
async function serveTranslatedWebsite(domain, path, language, res) {
  try {
    console.log('Serving translated website:', { domain, path, language });

    const baseUrl = `https://${domain}`;
    const pageUrl = `${baseUrl}${path}`;

    // Get website ID
    const website = findWebsite.get(domain);
    if (!website) {
      return res.status(404).send('Website not found');
    }

    // Fetch original website content
    const response = await axios.get(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    });

    // Load HTML content
    const $ = cheerio.load(response.data, { decodeEntities: false });

    // Get translations
    const getTranslations = db.prepare(`
      SELECT original_text, translated_text, element_type
      FROM translations
      WHERE website_id = ? AND path = ? AND language = ?
    `);
    const translations = getTranslations.all(website.id, path, language);

    // Preserve all original styles first
    const originalStyles = [];
    $('style, link[rel="stylesheet"]').each((i, el) => {
      originalStyles.push($(el).clone());
    });

    // Add a wrapper to maintain CSS context
    $('body').wrapInner('<div class="website-translation-wrapper"></div>');
    
    // Re-inject all original styles at the top of the wrapper
    const $wrapper = $('.website-translation-wrapper');
    originalStyles.forEach(style => {
      $wrapper.prepend(style);
    });

    // Replace content with translations - ONLY TEXT, NOTHING ELSE
    translations.forEach(translation => {
      const selector = `${translation.element_type}:contains("${translation.original_text}")`;
      $(selector).each((i, el) => {
        const $el = $(el);
        
        // Walk through all text nodes and replace ONLY text content
        function walkAndReplace(node) {
          if (node.nodeType === 3) { // Text node
            if (node.nodeValue.includes(translation.original_text)) {
              node.nodeValue = node.nodeValue.replace(
                translation.original_text,
                translation.translated_text || translation.original_text
              );
            }
          }
          // Continue walking through child nodes
          node.childNodes?.forEach(walkAndReplace);
        }
        
        // Start walking from the element
        walkAndReplace(el);
      });
    });

    // Update internal links while preserving styles
    $('a').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (href && !href.startsWith('#')) {
        try {
          const hrefUrl = new URL(href, baseUrl);
          if (hrefUrl.hostname === domain) {
            // Only update href, preserve everything else
            $el.attr('href', `/view/${domain}${hrefUrl.pathname}${hrefUrl.search}?lang=${language}`);
          }
        } catch (e) {
          console.log('Invalid href:', href);
        }
      }
    });

    // Add style to ensure wrapper doesn't affect layout
    $('head').append(`
      <style>
        .website-translation-wrapper {
          all: inherit;
          display: contents;
        }
      </style>
    `);

    // Fix all asset paths and preserve attributes
    $('img, script, link, source, video, audio').each((i, el) => {
      const $el = $(el);
      ['src', 'href', 'poster'].forEach(attr => {
        const value = $el.attr(attr);
        if (value && !value.startsWith('http') && !value.startsWith('data:')) {
          try {
            const absoluteUrl = new URL(value, baseUrl).href;
            $el.attr(attr, absoluteUrl);
          } catch (e) {
            console.log(`Invalid ${attr}:`, value);
          }
        }
      });
    });

    // Add meta tags for proper rendering
    $('head').prepend(`
      <meta charset="UTF-8">
      <base href="${baseUrl}/">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    `);

    // Send modified HTML with proper content type
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (error) {
    console.error('Error serving translated website:', error);
    res.status(500).send(`Error loading translated website: ${error.message}`);
  }
}

// Update the view endpoint to handle the root path
app.get('/view/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const path = '/';
    const language = req.query.lang || 'en';

    console.log('Serving translated website:', { domain, path, language });

    // Get website ID
    const website = findWebsite.get(domain);
    console.log('Found website:', website);
    
    if (!website) {
      return res.status(404).send('Website not found');
    }

    // Get translations for this path
    const getTranslations = db.prepare(`
      SELECT original_text, translated_text, element_type
      FROM translations
      WHERE website_id = ? AND path = ? AND language = ?
    `);
    const translations = getTranslations.all(website.id, path, language);
    console.log(`Found ${translations.length} translations for path ${path}`);

    // Fetch original website content
    const url = `https://${domain}`;
    console.log('Fetching content from:', url);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    // Load HTML content
    const $ = cheerio.load(response.data);

    // Replace content with translations - ONLY TEXT, NOTHING ELSE
    translations.forEach(translation => {
      const selector = `${translation.element_type}:contains("${translation.original_text}")`;
      $(selector).each((i, el) => {
        const $el = $(el);
        
        // Walk through all text nodes and replace ONLY text content
        function walkAndReplace(node) {
          if (node.nodeType === 3) { // Text node
            if (node.nodeValue.includes(translation.original_text)) {
              node.nodeValue = node.nodeValue.replace(
                translation.original_text,
                translation.translated_text || translation.original_text
              );
            }
          }
          // Continue walking through child nodes
          node.childNodes?.forEach(walkAndReplace);
        }
        
        // Start walking from the element
        walkAndReplace(el);
      });
    });

    // Update all internal links to use our proxy
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          const hrefUrl = new URL(href, `https://${domain}`);
          if (hrefUrl.hostname === domain) {
            $(el).attr('href', `/view/${domain}${hrefUrl.pathname}${hrefUrl.search}?lang=${language}`);
          }
        } catch (e) {
          console.log('Invalid href:', href);
        }
      }
    });

    // Fix relative paths for assets
    $('img, script, link').each((i, el) => {
      const $el = $(el);
      const src = $el.attr('src') || $el.attr('href');
      if (src && !src.startsWith('http')) {
        const absoluteSrc = new URL(src, `https://${domain}`).href;
        if ($el.attr('src')) {
          $el.attr('src', absoluteSrc);
        } else {
          $el.attr('href', absoluteSrc);
        }
      }
    });

    // Then modify the translation lookup in the view endpoint
    const elements = $('h1, h2, h3, h4, h5, h6, p, span, a, button');
    elements.each((i, el) => {
      const $el = $(el);
      const originalText = $el.text().trim();
      if (originalText) {
        // Get translation from database
        const translation = getTranslation.get(domain, originalText, language);
        if (translation?.translated_text) {
          $el.text(translation.translated_text);
        }
      }
    });

    // Send modified HTML
    res.send($.html());

  } catch (error) {
    console.error('Error serving translated website:', error);
    res.status(500).send(`Error loading translated website: ${error.message}`);
  }
});

// Add a helper function to get website ID
const getWebsiteByDomain = db.prepare(`
  SELECT id, domain FROM websites WHERE domain = ?
`);

// Add a separate route for paths
app.get('/view/:domain/*', async (req, res) => {
  try {
    const { domain } = req.params;
    const path = req.params[0] || '';
    const lang = req.query.lang || 'en';

    console.log('View request:', { domain, path, lang });

    // Verify website exists
    const website = getWebsiteByDomain.get(domain);
    if (!website) {
      throw new Error(`Website not found: ${domain}`);
    }

    // Construct the original URL
    const protocol = domain.includes('localhost') ? 'http:' : 'https:';
    const originalUrl = `${protocol}//${domain}/${path}`;

    // Fetch the original page
    const response = await axios.get(originalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    // Load the HTML with cheerio while preserving whitespace and structure
    const $ = cheerio.load(response.data, {
      decodeEntities: false,
      xmlMode: false,
      normalizeWhitespace: false
    });

    // Remove any existing base tags and add our own
    $('base').remove();
    $('head').prepend(`<base href="${protocol}//${domain}/">`);

    // Fix relative URLs
    $('[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('mailto:') && !href.startsWith('#')) {
        $(el).attr('href', href.startsWith('/') ? href.substring(1) : href);
      }
    });

    $('[src]').each((i, el) => {
      const src = $(el).attr('src');
      if (src && !src.startsWith('http') && !src.startsWith('//')) {
        $(el).attr('src', src.startsWith('/') ? src.substring(1) : src);
      }
    });

    // Handle inline styles
    $('[style]').each((i, el) => {
      let style = $(el).attr('style');
      if (style) {
        style = style.replace(/url\(['"]?([^'"http)]+)['"]?\)/g, (match, p1) => {
          if (p1.startsWith('data:')) return match;
          return `url('${p1.startsWith('/') ? p1.substring(1) : p1}')`;
        });
        $(el).attr('style', style);
      }
    });

    // Handle style tags
    $('style').each((i, el) => {
      let css = $(el).html();
      css = css.replace(/url\(['"]?([^'"http)]+)['"]?\)/g, (match, p1) => {
        if (p1.startsWith('data:')) return match;
        return `url('${p1.startsWith('/') ? p1.substring(1) : p1}')`;
      });
      $(el).html(css);
    });

    // Translate text content
    const elements = $('h1, h2, h3, h4, h5, h6, p, span, a, button');
    elements.each((i, el) => {
      const $el = $(el);
      const originalText = $el.text().trim();
      
      if (originalText) {
        try {
          const translation = getTranslation.get(domain, originalText, lang);
          if (translation?.translated_text) {
            // Preserve HTML structure inside the element
            const originalHtml = $el.html();
            const translatedHtml = originalHtml.replace(originalText, translation.translated_text);
            $el.html(translatedHtml);
          }
        } catch (err) {
          console.error('Translation error:', {
            error: err.message,
            domain,
            text: originalText.substring(0, 50),
            lang
          });
        }
      }
    });

    // Send the modified HTML
    res.send($.html());

  } catch (error) {
    console.error('View endpoint error:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Add this helper function
function isValidWebpagePath(url) {
  // Ignore these patterns
  const invalidPatterns = [
    /^mailto:/,
    /^tel:/,
    /^#/,
    /^javascript:/,
    /\.(jpg|jpeg|png|gif|ico|css|js|pdf|doc|docx|zip)$/i,
    /@/,  // Filter out email addresses
    /^[^/]*:/  // Filter out any protocol-like strings
  ];

  // Check if URL matches any invalid pattern
  if (invalidPatterns.some(pattern => pattern.test(url))) {
    return false;
  }

  // Ensure it's a relative path or starts with /
  return url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
}

// Modify the link extraction in map-website endpoint
const getPageLinks = (html, baseUrl) => {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    try {
      // Handle relative and absolute URLs
      let fullUrl;
      try {
        fullUrl = new URL(href, baseUrl);
      } catch {
        return; // Invalid URL
      }

      // Only include paths from the same domain
      if (fullUrl.hostname === new URL(baseUrl).hostname && isValidWebpagePath(fullUrl.pathname)) {
        links.add(fullUrl.pathname);
      }
    } catch (error) {
      console.error('Error processing link:', error);
    }
  });

  return Array.from(links);
};

// New endpoint to map website structure
app.post('/api/map-website', async (req, res) => {
  try {
    const { url } = req.body;
    console.log('Mapping website structure:', { url });

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname;
    const baseUrl = `${parsedUrl.protocol}//${domain}`;
    
    // Initialize queue and visited sets
    const pagesQueue = new Set([parsedUrl.pathname]);
    const visitedPages = new Set();
    const foundPages = [];
    const maxPages = 20; // Limit the number of pages to scan

    while (pagesQueue.size > 0 && visitedPages.size < maxPages) {
      const currentPath = Array.from(pagesQueue)[0];
      pagesQueue.delete(currentPath);
      
      if (visitedPages.has(currentPath)) continue;
      visitedPages.add(currentPath);

      try {
        const pageUrl = `${baseUrl}${currentPath}`;
        const response = await axios.get(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 5000
        });

        const $ = cheerio.load(response.data);
        const title = $('title').text() || currentPath;
        const textCount = $('h1, h2, h3, h4, h5, h6, p, span, a, button').text().trim().length;
        
        foundPages.push({
          path: currentPath,
          title,
          textCount
        });

        // Get new links from this page
        const links = await getPageLinks(response.data, baseUrl);
        links.forEach(link => {
          if (!visitedPages.has(link)) {
            pagesQueue.add(link);
          }
        });
      } catch (error) {
        console.error(`Error scanning page ${currentPath}:`, error.message);
      }
    }

    res.json({
      domain,
      pages: foundPages,
      totalPages: foundPages.length
    });

  } catch (error) {
    console.error('Error mapping website:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to map website',
      details: error.stack
    });
  }
});

// Modify the existing fetch-website endpoint
app.post('/api/fetch-website', async (req, res) => {
  try {
    const { url, selectedPages } = req.body;
    console.log('Processing website:', { url, selectedPages });

    if (!url || !selectedPages || !selectedPages.length) {
      return res.status(400).json({ error: 'URL and selected pages are required' });
    }

    // Parse and validate URL
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname;
    console.log('Extracted domain:', domain);

    // Begin transaction
    const transaction = db.transaction(() => {
      // Try to find existing website
      let website = findWebsite.get(domain);
      console.log('Found existing website:', website);

      if (!website) {
        // Insert new website
        const result = insertWebsite.run(domain);
        const websiteId = result.lastInsertRowid;
        website = { id: websiteId, domain };
        console.log('Created new website:', website);
      }

      if (!website || !website.id) {
        throw new Error('Failed to create or find website');
      }

      return website;
    });

    // Execute transaction
    const website = transaction();
    console.log('Using website:', website);

    // Modify the fetching logic to only process selected pages
    const baseUrl = `${parsedUrl.protocol}//${domain}`;
    
    let totalInsertedCount = 0;

    // Process each selected page
    for (const pagePath of selectedPages) {
      const pageUrl = `${baseUrl}${pagePath}`;
      const response = await axios.get(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      let insertedCount = 0;

      $('h1, h2, h3, h4, h5, h6, p, span, a, button').each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        
        if (text) {
          try {
            insertTranslation.run(
              website.id,
              text,
              null,
              'en',
              pagePath,
              el.name
            );
            insertedCount++;
          } catch (error) {
            console.error('Error inserting translation:', error);
          }
        }
      });

      totalInsertedCount += insertedCount;
    }

    res.json({ 
      message: 'Website content stored successfully',
      websiteId: website.id,
      domain: website.domain,
      translationsCount: totalInsertedCount
    });

  } catch (error) {
    console.error('Error processing website:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to process website',
      details: error.stack
    });
  }
});

// Endpoint to translate stored content
app.post('/api/translate-website', async (req, res) => {
  try {
    const { websiteId, targetLanguage } = req.body;
    
    // Get all untranslated content for this website
    const untranslated = db.prepare(`
      SELECT * FROM translations 
      WHERE website_id = ? AND translated_text IS NULL
    `).all(websiteId);

    // Translate each piece of content
    for (const item of untranslated) {
      const translatedText = await translateText(item.original_text, targetLanguage);
      db.prepare(`
        UPDATE translations 
        SET translated_text = ?, language = ?
        WHERE id = ?
      `).run(translatedText, targetLanguage, item.id);
    }

    res.json({ message: 'Website translated successfully' });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ error: 'Failed to translate website' });
  }
});

// Endpoint to get translated content
app.get('/api/get-translation', (req, res) => {
  try {
    const { domain, path, language } = req.query;
    const website = findWebsite.get(domain);
    
    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }

    const translations = findTranslations.all(website.id, language, path);
    res.json({ translations });
  } catch (error) {
    console.error('Error fetching translations:', error);
    res.status(500).json({ error: 'Failed to fetch translations' });
  }
});

// Get all websites endpoint
app.get('/api/websites', (req, res) => {
  try {
    const getWebsites = db.prepare('SELECT * FROM websites ORDER BY created_at DESC');
    const websites = getWebsites.all();
    res.json(websites);
  } catch (error) {
    console.error('Error fetching websites:', error);
    res.status(500).json({ error: 'Failed to fetch websites' });
  }
});

// Get translations endpoint
app.get('/api/translations/:websiteId', (req, res) => {
  try {
    const { websiteId } = req.params;
    const getTranslations = db.prepare(`
      SELECT translations.*, websites.domain
      FROM translations
      JOIN websites ON translations.website_id = websites.id
      WHERE website_id = ?
      ORDER BY translations.created_at DESC
    `);
    const translations = getTranslations.all(websiteId);
    res.json(translations);
  } catch (error) {
    console.error('Error fetching translations:', error);
    res.status(500).json({ error: 'Failed to fetch translations' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 