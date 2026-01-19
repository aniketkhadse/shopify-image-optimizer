
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";

console.log("Starting runtime check...");

async function test() {
    try {
        console.log("Testing Sharp...");
        const img = sharp({
            create: {
                width: 10,
                height: 10,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 0.5 }
            }
        });
        await img.png().toBuffer();
        console.log("Sharp OK");
    } catch (e) {
        console.error("Sharp crashed:", e);
    }

    try {
        console.log("Testing Prisma...");
        const prisma = new PrismaClient();
        await prisma.$connect();
        console.log("Prisma Connect OK");
        await prisma.$disconnect();
    } catch (e) {
        console.error("Prisma crashed:", e);
    }
}

test().then(() => console.log("Done"));
