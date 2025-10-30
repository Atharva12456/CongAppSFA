# Environment Variables Setup

## Required Environment Variables

- `SEMANTIC_SCHOLAR_API_KEY` - Your Semantic Scholar API key

## Local Development Setup

### 1. Create `.env` file in project root:

```bash
# Create the file manually
echo "SEMANTIC_SCHOLAR_API_KEY=XcsKxF9OmO6fbLVAVTFTx9wemVW2AYrU8vfZXBvp" > .env
```

Or create `.env` file manually with this content:

```
SEMANTIC_SCHOLAR_API_KEY=XcsKxF9OmO6fbLVAVTFTx9wemVW2AYrU8vfZXBvp
```

### 2. Install Dependencies

```bash
npm install
pip install requests sentence-transformers
```

### 3. Run the Application

```bash
npm run dev:full
```

The server will automatically load the API key from `.env` file.

---

## Deployment to Render.com

### Step 1: Push Code to GitHub

```bash
git add .
git commit -m "Add environment variable support for API key"
git push
```

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign up
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Render will auto-detect the `render.yaml` file
5. **IMPORTANT**: Before deploying, add environment variable:
   - Go to "Environment" tab
   - Add:
     - Key: `SEMANTIC_SCHOLAR_API_KEY`
     - Value: `XcsKxF9OmO6fbLVAVTFTx9wemVW2AYrU8vfZXBvp`
6. Click "Create Web Service"

### Step 3: Update Frontend to Use Backend URL

After deployment, Render will give you a URL like: `https://congapp-backend.onrender.com`

Update `src/MindMapMVP.tsx` (around line 240):

```typescript
const response = await fetch('https://YOUR-RENDER-URL.onrender.com/api/research', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: prompt || title })
});
```

Replace `https://YOUR-RENDER-URL.onrender.com` with your actual Render URL.

---

## Security Notes

⚠️ **NEVER commit the `.env` file to GitHub!**
- The `.env` file is already in `.gitignore`
- Always set environment variables through:
  - `.env` file locally
  - Deployment platform's environment variable settings (Render, Heroku, etc.)

---

## Troubleshooting

### Error: "No API key found"
- Make sure `.env` file exists in project root
- Make sure the file contains: `SEMANTIC_SCHOLAR_API_KEY=your_key_here`
- Restart the server after creating/modifying `.env`

### Server can't read environment variables
- Check that `server.js` is passing environment variables to Python process
- Verify Python script is reading `os.environ.get('SEMANTIC_SCHOLAR_API_KEY')`

