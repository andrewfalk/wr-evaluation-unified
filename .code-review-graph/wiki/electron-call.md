# electron-call

## Overview

File-based community: c:\Users\skirc\wr-evaluation-unified\electron\main.js

- **Size**: 9 nodes
- **Cohesion**: 0.1781
- **Dominant Language**: javascript

## Members

| Name | Kind | File | Lines |
|------|------|------|-------|
| createWindow | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 19-99 |
| netRequest | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 150-168 |
| callClaude | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 170-185 |
| callGemini | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 187-199 |
| f | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 217-217 |
| extractFromWal | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 251-318 |
| readVarint | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 320-329 |
| extractFromRawScan | Function | c:\Users\skirc\wr-evaluation-unified\electron\main.js | 332-364 |

## Execution Flows

- **callClaude** (criticality: 0.48, depth: 1)
- **callGemini** (criticality: 0.48, depth: 1)
- **extractFromWal** (criticality: 0.36, depth: 1)

## Dependencies

### Outgoing

- `on` (5 edge(s))
- `slice` (4 edge(s))
- `push` (4 edge(s))
- `join` (3 edge(s))
- `send` (3 edge(s))
- `setZoomLevel` (3 edge(s))
- `toString` (3 edge(s))
- `stringify` (2 edge(s))
- `getZoomLevel` (2 edge(s))
- `from` (2 edge(s))
- `indexOf` (2 edge(s))
- `parse` (2 edge(s))
- `min` (2 edge(s))
- `endsWith` (2 edge(s))
- `includes` (1 edge(s))
