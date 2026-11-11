import { z } from "zod";

export const ParcelSchema = z.object({
  weight: z.number().positive(),
  weight_unit: z.enum(["kg", "lb"]),
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  dim_unit: z.enum(["cm", "in"]),
  quantity: z.number().int().positive().default(1).optional(),
});

export const QuoteShipmentInput = z.object({
  origin_cp: z.string().optional(),
  origin_city: z.string().optional(),
  destination_cp: z.string().optional(),
  destination_city: z.string().optional(),
  parcels: z.array(ParcelSchema).min(1),
  type: z.enum(["package", "envelope"]),
  priority: z.enum(["cheapest", "fastest", "deadline"]).default("cheapest"),
  deadline: z.union([z.literal("next_day"), z.string()]).optional(),
  declared_value_mxn: z.number().positive().optional(),
  carriers: z.array(z.string()).optional(),
}).strict();

export type QuoteShipmentInputT = z.infer<typeof QuoteShipmentInput>;
export type ParcelT = z.infer<typeof ParcelSchema>;

// JSON schema shape for the Anthropic tool definition
export const quoteShipmentJsonSchema = {
  type: "object" as const,
  properties: {
    origin_cp: { type: "string", description: "5-digit Mexican postal code if the user wrote one" },
    origin_city: { type: "string", description: "City name if the user gave a city instead of a CP" },
    destination_cp: { type: "string" },
    destination_city: { type: "string" },
    parcels: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          weight: { type: "number" },
          weight_unit: { type: "string", enum: ["kg", "lb"] },
          length: { type: "number", description: "First dimension the user gave" },
          width: { type: "number", description: "Second dimension" },
          height: { type: "number", description: "Third dimension" },
          dim_unit: { type: "string", enum: ["cm", "in"] },
          quantity: { type: "integer", minimum: 1, description: "Number of identical parcels; default 1" },
        },
        required: ["weight", "weight_unit", "length", "width", "height", "dim_unit"],
      },
    },
    type: { type: "string", enum: ["package", "envelope"], description: "envelope = sobre / documents" },
    priority: { type: "string", enum: ["cheapest", "fastest", "deadline"] },
    deadline: { type: "string", description: "'next_day' or an ISO date" },
    declared_value_mxn: { type: "number" },
    carriers: { type: "array", items: { type: "string" }, description: "Only when the user named carriers" },
  },
  required: ["parcels", "type"],
};
