import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NotificationsFeedController } from './notifications-feed.controller.js';
import {
  NOTIFICATIONS_FEED_REPOSITORY,
  NotificationsFeedRepository,
} from './notifications-feed.repository.js';

/**
 * NOTIF feed (x151) wiring — the flat notifications feed route.
 *
 * A module of its own rather than folded into {@link InboxModule} or the preferences module:
 * the inbox reads notifications *bundled by object* and resolves each object through the work
 * and requests services (a dependency graph the feed has no use for), and preferences touch no
 * notification row at all. Registering this as its own module in `app.module.ts` — the
 * integrator-reconciled append point — keeps the slice file-disjoint. It depends on nothing but
 * the global tenant database; the stateless {@link NotificationsFeedRepository} is provided by
 * its token (ADR-0003) and the controller reads through it.
 */
@Module({})
export class NotificationsFeedModule {
  static register(): DynamicModule {
    return {
      module: NotificationsFeedModule,
      providers: [
        { provide: NOTIFICATIONS_FEED_REPOSITORY, useClass: NotificationsFeedRepository },
      ],
      controllers: [NotificationsFeedController],
    };
  }
}
