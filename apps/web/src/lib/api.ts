import { createApiClient } from "@althea/shared";

const baseUrl =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const api = createApiClient(baseUrl);
