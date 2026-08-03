export interface HealthResponse {
  status: "ok";
  environment: string;
  version: string;
}

export interface ReadinessResponse {
  status: "ready" | "degraded";
  database: boolean;
  redis: boolean;
}
