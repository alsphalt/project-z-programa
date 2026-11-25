export const PERMISSIONS = [
  'server.manage',
  'server.power',
  'file.read',
  'file.write',
  'file.delete',
  'deploy',
  'rollback',
  'backup.manage',
  'console.read',
  'console.command',
  'download',
  'download.sensitive',
  'settings.manage',
  'admin.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const OPERATOR: Permission[] = [
  'server.power',
  'file.read',
  'file.write',
  'file.delete',
  'deploy',
  'rollback',
  'backup.manage',
  'console.read',
  'console.command',
  'download',
];

const ADMIN: Permission[] = [...OPERATOR, 'server.manage', 'settings.manage', 'download.sensitive'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: ADMIN,
  operator: OPERATOR,
  viewer: ['file.read', 'console.read', 'download'],
};

export interface Principal {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: Permission[];
}

export function permissionsFor(role: Role, extra: string[] = []): Permission[] {
  const base = new Set<string>(ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.viewer);
  for (const permission of extra) {
    if ((PERMISSIONS as readonly string[]).includes(permission)) base.add(permission);
  }
  return [...base] as Permission[];
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  if (principal.role === 'owner') return true;
  if (principal.permissions.includes(permission)) return true;
  return (ROLE_PERMISSIONS[principal.role] ?? []).includes(permission);
}

export function assertPermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    const error = new Error(
      `Your role (${principal.role}) does not include the "${permission}" permission.`,
    );
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}
