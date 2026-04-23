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
  | 'cross_referenced'
  | 'legacy_unverified'
  | 'disputed'
  | 'deprecated';

export type Cost = 'free' | 'local_rate' | 'premium' | 'unknown';
export type IconName =
  | 'alert'
  | 'brain'
  | 'child'
  | 'shield'
  | 'heart'
  | 'globe'
  | 'map'
  | 'phone'
  | 'chat'
  | 'sms'
  | 'dataset';

export interface ChannelsSummary {
  has_voice: boolean;
  has_sms: boolean;
  has_chat: boolean;
  has_email: boolean;
}

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
  provenance?: Record<string, unknown> | null;
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
  category_counts?: Record<string, number>;
  channels?: ChannelsSummary;
  last_updated?: string | null;
}

export interface CountryManifestEntry {
  alpha2: string;
  alpha3: string;
  name: string;
  region?: string | null;
  subregion?: string | null;
  hotline_count: number;
  verified_count: number;
  categories: HotlineCategory[];
  category_counts: Record<string, number>;
  general_emergency: string[];
  centroid?: { lat: number; lng: number } | null;
  last_updated: string | null;
  channels: ChannelsSummary;
}

export interface Manifest {
  generated_at: string;
  schema_version: string;
  total_countries: number;
  total_hotlines: number;
  countries: CountryManifestEntry[];
  categories_reference: Record<string, string>;
}

export interface CategoryGlobalStat {
  slug: string;
  label: string;
  count: number;
  countries: number;
  verified_count: number;
}

export interface CategoriesStats {
  generated_at: string;
  categories: CategoryGlobalStat[];
}

export type FreshnessLevel = 'fresh' | 'ok' | 'stale' | 'unknown';

export interface FreshnessInfo {
  label: string;
  level: FreshnessLevel;
  dateStr: string | null;
}

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  verified_web: 'Verified (web)',
  verified_authority: 'Verified (authority)',
  verified_knowledge: 'Verified (knowledge base)',
  cross_referenced: 'Cross-referenced',
  legacy_unverified: 'Not yet verified',
  disputed: 'Disputed',
  deprecated: 'Deprecated',
};

export const CRISIS_PRIORITY: HotlineCategory[] = [
  'suicide_crisis',
  'mental_health',
  'domestic_violence',
  'sexual_violence',
  'child_protection',
  'general_support',
];

export const CATEGORY_META: Record<string, { label: string; icon: IconName; description: string }> = {
  emergency: { label: 'General emergency', icon: 'alert', description: 'Police, fire, and ambulance services' },
  suicide_crisis: { label: 'Suicide & acute crisis', icon: 'alert', description: 'Immediate crisis support and suicide prevention' },
  mental_health: { label: 'Mental health', icon: 'brain', description: 'General mental health support and counselling' },
  child_protection: { label: 'Child protection', icon: 'child', description: 'Child abuse, welfare, and children in crisis' },
  youth: { label: 'Youth', icon: 'child', description: 'General youth helplines (non-abuse)' },
  domestic_violence: { label: 'Domestic violence', icon: 'shield', description: 'Domestic abuse and intimate partner violence' },
  sexual_violence: { label: 'Sexual violence', icon: 'heart', description: 'Rape crisis, sexual assault, and survivor support' },
  lgbtqia: { label: 'LGBTQIA+ support', icon: 'heart', description: 'LGBTQIA+ specific support and crisis lines' },
  substance_use: { label: 'Substance use', icon: 'heart', description: 'Drug and alcohol addiction support' },
  elder_abuse: { label: 'Elder abuse', icon: 'shield', description: 'Elder abuse, neglect, and protection' },
  veterans: { label: 'Veterans', icon: 'shield', description: 'Military veterans and serving personnel' },
  human_trafficking: { label: 'Human trafficking', icon: 'shield', description: 'Human trafficking, modern slavery, forced labour' },
  disaster: { label: 'Disaster relief', icon: 'globe', description: 'Disaster relief and disaster distress' },
  missing_persons: { label: 'Missing persons', icon: 'map', description: 'Missing persons and runaway children' },
  bereavement: { label: 'Bereavement', icon: 'heart', description: 'Grief and bereavement support' },
  eating_disorders: { label: 'Eating disorders', icon: 'heart', description: 'Eating disorder support and recovery' },
  gambling: { label: 'Gambling', icon: 'dataset', description: 'Problem gambling support' },
  self_harm: { label: 'Self-harm', icon: 'heart', description: 'Self-injury specific support' },
  perinatal: { label: 'Perinatal', icon: 'child', description: 'Pregnancy loss and postnatal support' },
  disability: { label: 'Disability', icon: 'shield', description: 'Disability, chronic illness, and condition-specific support' },
  stalking: { label: 'Stalking', icon: 'shield', description: 'Stalking and harassment support' },
  male_victims: { label: 'Male victims', icon: 'shield', description: 'Helplines specifically for male victims of abuse' },
  refugee_migrant: { label: 'Refugee & migrant', icon: 'globe', description: 'Refugee, asylum seeker, and migrant support' },
  general_support: { label: 'General support', icon: 'heart', description: 'Loneliness, wellbeing, and non-specific listening lines' },
  legal_aid: { label: 'Legal aid', icon: 'shield', description: 'Legal aid and civil legal advice' },
  animal_welfare: { label: 'Animal welfare', icon: 'heart', description: 'Animal welfare and protection services' },
  human_rights: { label: 'Human rights', icon: 'globe', description: 'Human rights reporting and ombudsperson services' },
  financial_aid: { label: 'Financial aid', icon: 'dataset', description: 'Financial hardship, debt, and fraud support' },
  housing: { label: 'Housing', icon: 'map', description: 'Housing, homelessness, and shelter' },
};
