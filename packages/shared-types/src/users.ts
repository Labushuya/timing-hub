export type UserRole = 'admin' | 'veranstalter' | 'kommissar';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  display_name: string;
  locale: string;
  created_at: string;
  updated_at: string;
  deactivated_at?: string;
}

export interface RegistrationToken {
  id: string;
  token: string;
  issued_by: string;
  issued_to_email?: string;
  role: UserRole;
  used_at?: string;
  used_by?: string;
  expires_at: string;
  created_at: string;
}
