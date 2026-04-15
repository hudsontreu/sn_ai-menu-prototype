export const FIGMA_SYNC_CONFIG = {
  canvas: {
    width: 2102,
    height: 1336,
  },
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
  systemPromptAppend: [
    'You are extracting dynamic pricing/calorie overlay coordinates from menu-board designs.',
    'Use MCP Figma tools to inspect the design assets and return strictly structured output.',
    'Extract only dynamic value coordinates (price and calories), not static labels or item names.',
    'Coordinates must map to a 2102x1336 design frame.',
  ].join(' '),
  // Configure how the Claude Agent SDK connects to your Figma MCP server.
  // Example HTTP config:
  // { type: 'http', url: 'http://127.0.0.1:3845/mcp' }
  // Example stdio config:
  // { command: 'npx', args: ['-y', 'your-figma-mcp-server'] }
  mcpServer: {
    type: 'http',
    url: process.env.FIGMA_MCP_URL || '',
  },
  // Hardcoded Figma file references. Only designs requested at runtime are updated.
  designs: [
    {
      designId: 'design-a',
      designUrl: '@https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=1-2&m=dev',
      blankUrl: '@https://www.figma.com/design/DveUacGuz5nlURkX6OSrto/AI-Menu-Board-Pipeline?node-id=3-35&m=dev',
      outputAssetName: 'design-a-blank.png',
    },
    {
      designId: 'design-b',
      designUrl: '',
      blankUrl: '',
      outputAssetName: 'design-b-blank.png',
    },
    {
      designId: 'design-c',
      designUrl: '',
      blankUrl: '',
      outputAssetName: 'design-c-blank.png',
    },
  ],
};
