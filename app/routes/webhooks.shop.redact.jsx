import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
    const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

    // Implement your logic here to redact shop data
    // For this app (Image Optimizer), we primarily store image URLs which are public.
    // We might want to delete the ImageRecord entries for this shop if we were storing them by shop,
    // but currently we just store by shopifyImageId.
    // Since we don't store PII, we can just acknowledge.

    console.log(`[GDPR] Shop Redact request for ${shop}`);

    return new Response();
};
