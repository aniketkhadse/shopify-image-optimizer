import sharp from "sharp";
import prisma from "../db.server";

export const optimizer = {
    MAX_WIDTH: 2048,
    WEBP_LIMIT_KB: 200,

    async delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    async scanShop(admin, type = "all") {
        console.log("[Scan] Starting...");
        const results = [];
        const currentShopImageIds = new Set();

        try {
            // First, get all existing DB records
            const existingRecords = await prisma.imageRecord.findMany({
                select: {
                    shopifyImageId: true,
                    status: true,
                    savingsKb: true,
                    originalKb: true,
                    optimizedKb: true,
                    originalUrl: true
                }
            });

            const recordMap = new Map();
            existingRecords.forEach(r => recordMap.set(r.shopifyImageId, r));

            const optimizedCount = existingRecords.filter(r => r.status === "optimized").length;
            console.log(`[Scan] DB has ${existingRecords.length} records, ${optimizedCount} optimized`);

            if (type === "all" || type === "products") {
                let hasNextPage = true;
                let cursor = null;

                while (hasNextPage) {
                    const query = `#graphql
                        query getProducts($cursor: String) {
                            products(first: 50, after: $cursor) {
                                pageInfo { hasNextPage endCursor }
                                nodes {
                                    id
                                    title
                                    images(first: 20) {
                                        nodes { id url width height altText }
                                    }
                                }
                            }
                        }`;

                    const response = await admin.graphql(query, { variables: { cursor } });
                    const data = await response.json();
                    const products = data.data?.products?.nodes || [];

                    for (const p of products) {
                        for (const img of (p.images?.nodes || [])) {
                            currentShopImageIds.add(img.id);

                            const record = recordMap.get(img.id);
                            const isOptimized = record?.status === "optimized";

                            results.push({
                                id: img.id,
                                url: img.url,
                                parentId: p.id,
                                parentTitle: p.title,
                                type: "Product",
                                width: img.width,
                                height: img.height,
                                alt: img.altText,
                                optimized: isOptimized,
                                savedKb: isOptimized ? (record?.savingsKb || 0) : 0,
                                originalKb: record?.originalKb || 0,
                                optimizedKb: isOptimized ? (record?.optimizedKb || 0) : 0,
                                percent: (isOptimized && record?.originalKb) ? Math.round(((record.originalKb - record.optimizedKb) / record.originalKb) * 100) : 0
                            });
                        }
                    }

                    hasNextPage = data.data?.products?.pageInfo?.hasNextPage;
                    cursor = data.data?.products?.pageInfo?.endCursor;
                    if (results.length > 2500) hasNextPage = false;
                }
            }

            // Clean up stale DB records (images no longer in shop)
            const staleRecords = existingRecords.filter(r => !currentShopImageIds.has(r.shopifyImageId));
            if (staleRecords.length > 0) {
                console.log(`[Scan] Found ${staleRecords.length} stale DB records. Cleaning up...`);
                await prisma.imageRecord.deleteMany({
                    where: {
                        shopifyImageId: {
                            in: staleRecords.map(r => r.shopifyImageId)
                        }
                    }
                });
                console.log(`[Scan] Deleted ${staleRecords.length} stale records`);
            }

        } catch (error) {
            console.error("[Scan Error]", error);
        }

        console.log(`[Scan] Found ${results.length} images in shop`);
        return results;
    },

    async optimizeImageLogic(buffer, width) {
        const sizeKb = buffer.byteLength / 1024;
        let sharpInstance = sharp(buffer).rotate();

        if (width && width > this.MAX_WIDTH) {
            sharpInstance = sharpInstance.resize({ width: this.MAX_WIDTH, withoutEnlargement: true });
        }

        let outputBuffer;
        let format = 'webp';

        try {
            if (sizeKb < this.WEBP_LIMIT_KB) {
                outputBuffer = await sharpInstance.clone().webp({ quality: 80 }).toBuffer();
            } else {
                const webpBuffer = await sharpInstance.clone().webp({ quality: 80 }).toBuffer();
                const avifBuffer = await sharpInstance.clone().avif({ quality: 60, speed: 5 }).toBuffer();
                if (avifBuffer.byteLength < webpBuffer.byteLength) {
                    outputBuffer = avifBuffer;
                    format = 'avif';
                } else {
                    outputBuffer = webpBuffer;
                }
            }
        } catch (err) {
            console.error("[Sharp Error]", err);
            throw new Error("Image processing failed: " + err.message);
        }

        return { buffer: outputBuffer, format };
    },

    // SIMPLIFIED: No metafield backup, DB is source of truth
    async commitImage(admin, session, item) {
        console.log(`[Optimize] Starting: ${item.id}`);

        if (!session?.shop || !session?.accessToken) {
            throw new Error("Invalid session");
        }

        const productId = item.parentId;
        const imageId = item.id;

        // 1. Download original
        console.log(`[Optimize] Downloading: ${item.url}`);
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const originalBuffer = Buffer.from(await res.arrayBuffer());
        const originalKb = Math.round(originalBuffer.length / 1024);
        console.log(`[Optimize] Downloaded: ${originalKb}KB`);

        // 2. Optimize
        console.log(`[Optimize] Processing...`);
        const { buffer, format } = await this.optimizeImageLogic(originalBuffer, item.width);
        const optimizedKb = Math.round(buffer.length / 1024);
        console.log(`[Optimize] Compressed: ${originalKb}KB -> ${optimizedKb}KB (${format})`);

        // 3. Upload to Shopify (creates NEW image ID)
        console.log(`[Optimize] Uploading...`);
        const productNumericId = productId.split("/").pop();
        const imageNumericId = imageId.split("/").pop();

        const uploadRes = await fetch(
            `https://${session.shop}/admin/api/2024-10/products/${productNumericId}/images/${imageNumericId}.json`,
            {
                method: "PUT",
                headers: {
                    "X-Shopify-Access-Token": session.accessToken,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    image: {
                        id: Number(imageNumericId),
                        attachment: buffer.toString("base64"),
                        filename: `optimized.${format}`
                    }
                })
            }
        );

        if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            console.error(`[Optimize] Upload failed: ${uploadRes.status}`, errText);
            throw new Error(`Upload failed: ${uploadRes.status}`);
        }

        const uploadData = await uploadRes.json();
        const newImageId = uploadData.image?.id;

        if (!newImageId) {
            throw new Error("No image ID returned from upload");
        }

        const newGid = `gid://shopify/ProductImage/${newImageId}`;
        console.log(`[Optimize] Uploaded. New GID: ${newGid}`);

        // 4. DB is the SOURCE OF TRUTH - store backup here
        await prisma.imageRecord.upsert({
            where: { shopifyImageId: newGid },
            update: {
                status: "optimized",
                productId: productId,
                originalUrl: item.url,
                optimizedUrl: uploadData.image.src,
                originalKb,
                optimizedKb,
                savingsKb: originalKb - optimizedKb
            },
            create: {
                shopifyImageId: newGid,
                productId: productId,
                originalUrl: item.url,
                optimizedUrl: uploadData.image.src,
                status: "optimized",
                originalKb,
                optimizedKb,
                savingsKb: originalKb - optimizedKb
            }
        });

        // Cleanup old ID if changed
        if (newGid !== item.id) {
            console.log(`[Optimize] ID changed: ${item.id} -> ${newGid}`);
            try {
                await prisma.imageRecord.deleteMany({ where: { shopifyImageId: item.id } });
            } catch (e) {
                console.error("[Optimize] Error deleting old record:", e);
            }
        }

        console.log(`[Optimize] Complete! Saved ${originalKb - optimizedKb}KB`);

        return {
            beforeKb: originalKb,
            afterKb: optimizedKb,
            percent: Math.round(((originalKb - optimizedKb) / originalKb) * 100),
            newId: newGid  // CRITICAL: Return new ID for UI sync
        };
    },

    // SIMPLIFIED: DB-only restore, no metafield dependency
    async restoreImage(admin, session, item) {
        console.log(`[Restore] Starting: ${item.id}`);

        if (!session?.shop || !session?.accessToken) {
            throw new Error("Invalid session");
        }

        // Get original URL from DB (source of truth)
        const record = await prisma.imageRecord.findUnique({
            where: { shopifyImageId: item.id }
        });

        if (!record || !record.originalUrl) {
            throw new Error("Original image not found in DB. Cannot restore.");
        }

        console.log(`[Restore] Found original: ${record.originalUrl}`);

        const productNumericId = item.parentId.split("/").pop();
        const imageNumericId = item.id.split("/").pop();

        const restoreRes = await fetch(
            `https://${session.shop}/admin/api/2024-10/products/${productNumericId}/images/${imageNumericId}.json`,
            {
                method: "PUT",
                headers: {
                    "X-Shopify-Access-Token": session.accessToken,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    image: {
                        id: Number(imageNumericId),
                        src: record.originalUrl
                    }
                })
            }
        );

        if (!restoreRes.ok) {
            const errText = await restoreRes.text();
            console.error(`[Restore] Failed: ${restoreRes.status}`, errText);
            throw new Error(`Restore failed: ${restoreRes.status}`);
        }

        console.log(`[Restore] Success.`);

        // Delete DB record (image is now "pending" / original state)
        await prisma.imageRecord.delete({
            where: { shopifyImageId: item.id }
        });

        return { status: "restored" };
    }
};