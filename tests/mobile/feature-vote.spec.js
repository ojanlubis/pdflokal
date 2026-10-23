// The feature vote on a phone (mobile-chrome): see tests/helpers/feature-vote-cases.js.
import { test } from '@playwright/test';
import { defineFeatureVoteSuite } from '../helpers/feature-vote-cases.js';

test.use({ serviceWorkers: 'block' });

defineFeatureVoteSuite({ door: 'drawer' });
