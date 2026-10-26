export interface LibraryGeneratorSchema {
  name: string;
  type: "lib" | "state" | "ui" | "adapter" | "service";
  platform: "any" | "node" | "react" | "dom";
}
