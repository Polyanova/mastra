/**
 * Studio Auth Provider — proxies auth through the shared API.
 * No API keys needed in deployed instances.
 */

import { MastraAuthStudio, MastraRBACStudio } from '@mastra/auth-studio';
import { DEFAULT_ROLES } from '@mastra/core/auth';

import type { AuthResult } from './types';

export function initStudio(): AuthResult {
  const mastraAuth = new MastraAuthStudio({
    sharedApiUrl: process.env.MASTRA_SHARED_API_URL,
    organizationId: process.env.MASTRA_ORGANIZATION_ID,
  });

  const rbacProvider = new MastraRBACStudio({
    roleMapping: DEFAULT_ROLES,
  });

  return { mastraAuth, rbacProvider };
}
