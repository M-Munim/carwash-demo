// The demo backend: importing this registers every module's routes and sample data.
// Each module adds its own routes; core.js holds the adapter and the saved data.

import './auth';
import './bookings';
import './jobCards';
import './inventory';
import './broadcast';

export { demoAdapter, resetDemoData, CHANGE_TTL_MS } from './core';
export { DEMO_ACCOUNTS } from './auth';
