import type { Metadata } from 'next';
import { ProductPage } from '../../../components/website/pages/product/ProductPage';

export const metadata: Metadata = {
  title: 'Product overview',
  description:
    'One work graph, four ways to use it: a team workspace, a focus space, a client portal and a control center.',
};

/** **WEB-02 · Product overview.** Thin route entry; the page lives in components/website/pages. */
export default function ProductRoute() {
  return <ProductPage />;
}
