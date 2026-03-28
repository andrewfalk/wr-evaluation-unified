# utils-work

## Overview

File-based community: c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js

- **Size**: 7 nodes
- **Cohesion**: 0.5000
- **Dominant Language**: javascript

## Members

| Name | Kind | File | Lines |
|------|------|------|-------|
| calculateWorkPeriod | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js | 3-6 |
| formatWorkPeriod | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js | 8-12 |
| parseWorkPeriodOverride | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js | 14-19 |
| getEffectiveWorkPeriod | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js | 21-24 |
| getWorkPeriodYearMonth | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js | 26-35 |
| getEffectiveWorkPeriodText | Function | c:\Users\skirc\wr-evaluation-unified\src\core\utils\workPeriod.js | 37-40 |

## Execution Flows

- **getWorkPeriodYearMonth** (criticality: 0.36, depth: 1)
- **getEffectiveWorkPeriod** (criticality: 0.32, depth: 1)
- **getEffectiveWorkPeriodText** (criticality: 0.29, depth: 2)

## Dependencies

### Outgoing

- `match` (4 edge(s))
- `round` (2 edge(s))
- `floor` (2 edge(s))
- `parseInt` (2 edge(s))
- `max` (1 edge(s))
