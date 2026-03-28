# utils-export

## Overview

File-based community: c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js

- **Size**: 18 nodes
- **Cohesion**: 0.1949
- **Dominant Language**: javascript

## Members

| Name | Kind | File | Lines |
|------|------|------|-------|
| generateUnifiedEMR | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 10-151 |
| d | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 243-243 |
| j | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 263-263 |
| v | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 107-107 |
| buildUnifiedWorkbook | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 153-174 |
| exportSingle | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 176-179 |
| exportAsZip | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 181-207 |
| exportSelected | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 209-214 |
| p | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 371-371 |
| exportBatch | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 216-221 |
| generateBatchRows | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 237-343 |
| t | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 269-269 |
| e | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 255-255 |
| buildBatchWorkbook | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 345-353 |
| exportBatchFormatSingle | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 355-360 |
| exportBatchFormatSelected | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 362-368 |
| exportBatchFormatAll | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\exportService.js | 370-376 |

## Execution Flows

- **exportSelected** (criticality: 0.38, depth: 3)
- **exportBatch** (criticality: 0.38, depth: 3)
- **exportSingle** (criticality: 0.37, depth: 2)
- **exportBatchFormatSingle** (criticality: 0.37, depth: 2)
- **exportBatchFormatSelected** (criticality: 0.37, depth: 2)
- **exportBatchFormatAll** (criticality: 0.37, depth: 2)

## Dependencies

### Outgoing

- `push` (43 edge(s))
- `filter` (13 edge(s))
- `split` (9 edge(s))
- `toFixed` (8 edge(s))
- `forEach` (7 edge(s))
- `join` (7 edge(s))
- `map` (6 edge(s))
- `toISOString` (6 edge(s))
- `replace` (4 edge(s))
- `writeFile` (4 edge(s))
- `C:\Users\skirc\wr-evaluation-unified\src\core\moduleRegistry.js::getModule` (3 edge(s))
- `computeCalc` (3 edge(s))
- `C:\Users\skirc\wr-evaluation-unified\src\modules\knee\utils\calculations.js::getStatusText` (3 edge(s))
- `C:\Users\skirc\wr-evaluation-unified\src\modules\knee\utils\calculations.js::getReasonText` (3 edge(s))
- `has` (3 edge(s))
