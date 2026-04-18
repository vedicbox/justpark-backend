import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { UserRole } from '../types';

/**
 * Role-based access control middleware factory.
 *
 * Usage:
 *   // Allow only admins
 *   router.get('/admin/users', authenticate, requireRole('admin'), controller.listUsers)
 *
 *   // Allow hosts and admins
 *   router.post('/host/spaces', authenticate, requireRole('host', 'admin'), controller.create)
 *
 *   // Any authenticated user (user | host | admin)
 *   router.get('/bookings', authenticate, requireRole('user', 'host', 'admin'), controller.list)
 *
 * Must be used AFTER `authenticate` middleware (req.user must be set).
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }

    if (!roles.includes(req.user.role as UserRole)) {
      next(
        AppError.forbidden(
          `This action requires one of these roles: ${roles.join(', ')}. ` +
          `Your role is: ${req.user.role}`
        )
      );
      return;
    }

    next();
  };
}

/**
 * Convenience guards for common patterns.
 *
 * router.use('/admin', authenticate, isAdmin)
 * router.use('/host',  authenticate, isHost)
 */
export const isAdmin = requireRole('admin');
export const isHost  = requireRole('host', 'admin'); // admins can act as hosts
export const isUser  = requireRole('user', 'host', 'admin'); // any authenticated user

/**
 * Ownership guard — ensures the authenticated user can only
 * access their own resources, unless they are an admin.
 *
 * Usage:
 *   router.get('/users/:userId/bookings', authenticate, requireOwnerOrAdmin('userId'), ...)
 */
export function requireOwnerOrAdmin(paramKey = 'userId') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }

    const resourceOwnerId = req.params[paramKey];
    const isOwner = req.user.sub === resourceOwnerId;
    const isAdminUser = req.user.role === 'admin';

    if (!isOwner && !isAdminUser) {
      next(AppError.forbidden('You can only access your own resources'));
      return;
    }

    next();
  };
}
