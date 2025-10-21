# Mind Map MVP

A powerful mind mapping application built with React, TypeScript, and modern web technologies.

## Features

- **Interactive Mind Maps**: Create and edit mind maps with nodes and connections
- **Multiple Boards**: Organize your thoughts across different boards
- **Drawing Tools**: Add freehand drawings with pen tool
- **Export Functionality**: Export your mind maps as PNG images
- **Local Storage**: All data is automatically saved locally
- **Keyboard Shortcuts**: Efficient navigation and editing
- **Zoom & Pan**: Navigate large mind maps with smooth zoom and pan controls
- **Full Touch Support**: 
  - Single-finger drag to pan
  - Two-finger pinch to zoom
  - Two-finger drag to pan while zooming

## Getting Started

### Prerequisites

- Node.js (version 16 or higher)
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser and navigate to `http://localhost:3000`

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm start` - Alternative command to start dev server

## Usage

### Creating a New Board
- Click the "+ New prompt" button in the sidebar
- Enter a title for your mind map
- Press Enter or click "Create"

### Editing Nodes
- Double-click any node to edit its text
- Press Enter to save, Escape to cancel

### Adding Child Nodes
- Click the "+" handles around nodes to add children
- Leaf nodes show handles on top and bottom
- Non-leaf nodes show handles on all four sides

### Drawing
- Press "P" or click the "Pen" button to enter drawing mode
- Draw with your mouse or touch device
- Switch back to "Select" mode (V key) to interact with nodes

### Navigation

**Desktop Mouse:**
- **Zoom**: Mouse wheel (or Shift + wheel) or Ctrl/Cmd + Plus/Minus
- **Pan**: Hold Space and drag, or middle mouse button drag
- **Reset View**: Right-click and select "Fit to screen"

**Touchpad:**
- **Pan**: Two-finger scroll (up/down/left/right)
- **Zoom**: Pinch gesture (Ctrl + scroll on some touchpads)
- **Alternative Zoom**: Shift + scroll

**Touch Devices (Mobile/Tablet):**
- **Pan**: Drag with one finger to move around
- **Zoom**: Pinch with two fingers to zoom in/out
- **Pan + Zoom**: Use two fingers to zoom and pan simultaneously

### Keyboard Shortcuts
- `V` - Select mode
- `P` - Pen mode
- `Space` - Pan mode (hold and drag)
- `Ctrl/Cmd + Plus` - Zoom in
- `Ctrl/Cmd + Minus` - Zoom out

### Export
- Click "Export PNG" to download your current board as an image

## Deploying to GitHub Pages

This project is configured to automatically deploy to GitHub Pages using GitHub Actions.

### Setup Instructions

1. **Push your code to GitHub**:
   ```bash
   git add .
   git commit -m "Initial commit with GitHub Pages setup"
   git push origin main
   ```

2. **Enable GitHub Pages**:
   - Go to your repository on GitHub
   - Click on **Settings** → **Pages** (in the left sidebar)
   - Under **Source**, select **GitHub Actions**
   - The workflow will automatically deploy your app

3. **Access your app**:
   - After the workflow completes, your app will be available at:
   - `https://[your-username].github.io/CongressionalAppChallenge/`

### Manual Deployment

If you prefer to deploy manually:

1. Build the project:
   ```bash
   npm run build
   ```

2. The built files will be in the `dist` folder

3. Deploy the `dist` folder to any static hosting service

### Configuration Notes

- The `base` path in `vite.config.ts` is set to `/CongressionalAppChallenge/`
- If you rename the repository, update the `base` path accordingly
- The GitHub Actions workflow (`.github/workflows/deploy.yml`) handles automatic deployment

## Technology Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Zustand** - State management
- **LocalForage** - Local storage
- **Tailwind CSS** - Styling (via CDN)

## Project Structure

```
├── src/
│   ├── main.tsx          # Application entry point
│   └── MindMapMVP.tsx    # Main mind map component
├── index.html            # HTML template
├── package.json          # Dependencies and scripts
├── vite.config.ts        # Vite configuration
├── tsconfig.json         # TypeScript configuration
└── README.md            # This file
```

## Browser Support

This application works in all modern browsers that support:
- ES2020 features
- Canvas API
- Local Storage
- SVG

## License

This project is open source and available under the MIT License.