/**
 * hyperflow.serve
 *
 * x402 facilitator server.
 */

import "dotenv/config";

import express from "express";
import cors from "cors";
import { buildFacilitatorRouter } from "./facilitator.js";
import { appConfig } from "./config.js";

const port = appConfig.facilitator.port;
const logLevel = appConfig.process.logLevel;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/facilitator", buildFacilitatorRouter());

app.get("/", (_req, res) => {
  res.json({
    service: "hyperflow-facilitator",
    endpoints: ["/facilitator/health", "/facilitator/verify", "/facilitator/settle"],
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Starting facilitator on :${port} log_level=${logLevel}`);
});
