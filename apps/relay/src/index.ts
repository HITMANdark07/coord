import { createRelay } from "./relay";

const port = Number(process.env.RELAY_PORT ?? 4546);
const host = process.env.RELAY_HOST ?? "127.0.0.1";
createRelay({ port, host });
console.log(`relay listening on ws://${host}:${port}`);
