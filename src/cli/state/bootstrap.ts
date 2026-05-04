import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { apiClient } from '@/services/api/client';
import { loadCliConfig, getDefaultApiBase, type CliConfig } from './configStore';

let bootstrapped = false;
let cachedConfig: CliConfig = {};

/**
 * Translate `responseType: 'blob'` calls coming from the original SPA into
 * `responseType: 'arraybuffer'` so they work in Node. Downstream `.text()` /
 * `.toString('utf8')` callers must adapt; the wrapper below normalises that.
 */
function patchBlobDownloads() {
  const originalRequestRaw = apiClient.requestRaw.bind(apiClient);
  apiClient.requestRaw = async (config: AxiosRequestConfig): Promise<AxiosResponse> => {
    const next: AxiosRequestConfig = { ...config };
    if (next.responseType === 'blob') {
      next.responseType = 'arraybuffer';
    }
    const response = await originalRequestRaw(next);
    if (config.responseType === 'blob' && response.data instanceof ArrayBuffer) {
      const buf = Buffer.from(response.data);
      // Mimic the Browser Blob#text() interface used by services/api/authFiles.ts and logs.ts.
      (response as unknown as { data: { text: () => Promise<string> } }).data = {
        text: async () => buf.toString('utf8'),
      };
    }
    return response;
  };

  apiClient.getRaw = async (url: string, config?: AxiosRequestConfig) => {
    return apiClient.requestRaw({ ...config, method: 'GET', url });
  };
}

export async function bootstrap(options: { requireKey?: boolean } = {}): Promise<CliConfig> {
  if (!bootstrapped) {
    patchBlobDownloads();
    bootstrapped = true;
  }
  cachedConfig = await loadCliConfig();
  const apiBase = (cachedConfig.apiBase ?? getDefaultApiBase()).trim();
  const managementKey = (cachedConfig.managementKey ?? '').trim();

  apiClient.setConfig({ apiBase, managementKey });

  if (options.requireKey && !managementKey) {
    throw new Error(
      'No management key configured. Run `cpa connect --url <url> --key <key>` first.'
    );
  }
  return cachedConfig;
}

export function getCachedCliConfig(): CliConfig {
  return cachedConfig;
}
