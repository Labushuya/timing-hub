export type PostenRole = 'start' | 'finish' | 'intermediate' | 'sector_split';

export interface Posten {
  id: string;
  event_id: string;
  code: string;
  name: string;
  sort_order: number;
  role: PostenRole;
  access_token: string;
  bridge_token?: string;
  created_at: string;
}

export type PostenInfo = Omit<Posten, 'bridge_token'>;
