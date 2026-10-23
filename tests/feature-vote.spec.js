// The feature vote on desktop (chromium): see tests/helpers/feature-vote-cases.js.
import { test } from '@playwright/test';
import { defineFeatureVoteSuite } from './helpers/feature-vote-cases.js';

// Our own modules are served by a service worker after the first load, and
// page.route never sees what the SW fetches.
test.use({ serviceWorkers: 'block' });

defineFeatureVoteSuite({ door: 'nav' });
