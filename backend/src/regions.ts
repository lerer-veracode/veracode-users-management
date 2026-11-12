export const REGIONS = {
  us: { label: "US", baseUrl: "https://api.veracode.com/api/authn" },
  eu: { label: "EU", baseUrl: "https://api.veracode.eu/api/authn" },
  fed: { label: "US Federal", baseUrl: "https://api.veracode.us/api/authn" },
} as const;

export type Region = keyof typeof REGIONS;

export const isRegion = (value: string): value is Region => value in REGIONS;
