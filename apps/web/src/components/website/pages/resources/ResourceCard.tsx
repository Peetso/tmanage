import Link from '../../WebLink';
import { Badge } from '@tmanage/ui';
import { IconOrb, cx } from '../../primitives';
import { WebIcon } from '../../WebIcon';
import { CATEGORY_ICON, CATEGORY_LABEL, resourceHref, type Resource } from './resources-data';

/**
 * One resource card (featured side + library grid + "keep reading" on an article). The whole card
 * opens the article: the title is the link and its stretched box covers the card, so the link's
 * accessible name stays the title rather than every line of the card.
 */
export function ResourceCard({
  item,
  variant = 'grid',
  headingLevel = 'h3',
}: {
  item: Resource;
  variant?: 'grid' | 'side';
  headingLevel?: 'h2' | 'h3';
}) {
  const Heading = headingLevel;
  return (
    <article className={cx('tm-web-res-card', `tm-web-res-card--${variant}`)}>
      <div className="tm-web-res-card__top">
        <Badge mono>{CATEGORY_LABEL[item.category].toUpperCase()}</Badge>
        <IconOrb
          icon={CATEGORY_ICON[item.category]}
          tone={item.category === 'update' ? 'lime' : 'tint'}
          size="compact"
        />
      </div>
      <Heading className="tm-web-res-card__title">
        <Link href={resourceHref(item)} className="tm-web-res-card__link">
          {item.title}
        </Link>
      </Heading>
      <p className="tm-web-res-card__line">{item.line}</p>
      <p className="tm-web-res-card__meta">
        <span>{item.meta}</span>
        <span className="tm-web-res-card__go" aria-hidden="true">
          <WebIcon name="arrow-right" size={14} />
        </span>
      </p>
    </article>
  );
}
