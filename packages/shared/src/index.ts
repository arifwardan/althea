import type { HealthResponse, ReadinessResponse } from "@althea/types";

export interface ApiClient {
  health(): Promise<HealthResponse>;
  ready(): Promise<ReadinessResponse>;
}

export function createApiClient(baseUrl: string): ApiClient {
  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${path}`);
    }
    return (await response.json()) as T;
  }

  return {
    health: () => get<HealthResponse>("/api/v1/health"),
    ready: () => get<ReadinessResponse>("/api/v1/ready"),
  };
}
