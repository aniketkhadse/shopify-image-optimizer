import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
    const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

    // Implement your logic here to handle customer data requests
    // This app does not store customer data, so we just acknowledge.

    console.log(`[GDPR] Customer Data Request for ${shop}`);

    return new Response();
};
