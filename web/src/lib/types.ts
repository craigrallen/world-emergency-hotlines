// Types mirror schema v2.0 from the canonical hotlines.json.
// Kept deliberately permissive on optional fields so the adapter can serve
// partial records from the legacy information.json without TS gymnastics.

export type HotlineCategory =
  | 'emergency'
  | 'suicide_crisis'
  | 'mental_health'
  | 'child_protection'
  | 'youth'
  | 'domestic_violence'
  | 'sexual_violence'
  | 'lgbtqia'
  | 'substance_use'
  | 'elder_abuse'
  | 'veterans'
  | 'human_trafficking'
  | 'disaster'
  | 'missing_persons'
  | 'bereavement'
  | 'eating_disorders'
  | 'gambling'
  | 'self_harm'
  | 'perinatal'
  | 'disability'
  | 'stalking'
  | 'male_victims'
  | 'refugee_migrant'
  | 'general_support'
  | 'legal_aid'
  | 'animal_welfare'
  | 'human_rights'
  | 'financial_aid'
  | 'housing';

export type VerificationStatus =
  | 'verified_web'
  | 'verified_authority'
  | 'verified_knowledge'
  | 'legacy_unverified'
  | 'disputed'
  | 'deprecated';

export type Cost = 'free' | 'local_rate' | 'premium' | 'unknown';

export interface Hotline {
  name: string;
  organization?: string | null;
  category: HotlineCategory;
  voice_numbers: string[];
  sms_numbers: string[];
  text_numbers: string[];
  short_codes: string[];
  chat_url?: string | null;
  email?: string | null;
  website?: string | null;
  hours?: string | null;
  languages: string[];
  cost: Cost;
  target?: string | null;
  geography?: string | null;
  notes?: string | null;
  verification_status: VerificationStatus;
  last_verified?: string | null;
  sources: string[];
}

export interface Country {
  country: string;
  alpha2: string;
  alpha3: string;
  region?: string | null;
  subregion?: string | null;
  general_emergency: string[];
  notes?: string | null;
  centroid?: { lat: number; lng: number } | null;
  hotlines: Hotline[];
}

export interface CountryManifestEntry {
  alpha2: string;
  alpha3: string;
  name: string;
  region?: string | null;
  hotline_count: number;
  verified_count: number;
  categories: HotlineCategory[];
  general_emergency: string[];
  centroid?: { lat: number; lng: number } | null;
}

export interface Manifest {
  generated_at: string;
  schema_version: string;
  total_countries: number;
  total_hotlines: number;
  countries: CountryManifestEntry[];
  categories_reference: Record<string, string>;
}
