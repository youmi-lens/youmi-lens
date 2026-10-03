import { SUBSCRIPTION_PRODUCT_IDS } from './iapSubscriptions.mjs'

// The catalog is authoritative. Missing rows and failed requests fail closed.
export async function subscriptionAvailability(db) {
  const { data, error } = await db.from('billing_products')
    .select('product_id,kind,is_purchasable,sales_end_at').in('product_id', [...SUBSCRIPTION_PRODUCT_IDS])
  if (error) throw error
  return [...SUBSCRIPTION_PRODUCT_IDS].map((productId) => {
    const product = data?.find((row) => row.product_id === productId)
    const purchasable = product?.kind === 'auto_renewable' && product.is_purchasable === true &&
      (!product.sales_end_at || Date.parse(product.sales_end_at) > Date.now())
    return { productId, purchasable, tier: 'student_pass', environment: 'Production',
      policy: 'production_or_explicit_test_chain', reason: purchasable ? null : 'sales_closed' }
  })
}
