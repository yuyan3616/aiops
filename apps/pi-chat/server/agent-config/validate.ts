import { preflightExtensions } from "./extension-loader";
import { readConfigDirectory } from "./local-files";
import { validateBundle } from "./store";
if (!process.argv[2])
  throw new Error("请提供独立配置仓库目录：pnpm agent-config:validate /path/to/aiops-agent-config");
const files = readConfigDirectory(process.argv[2]);
const bundle = validateBundle("0".repeat(40), files);
if (bundle.schemaVersion === 2) await preflightExtensions(bundle, files);
process.stdout.write(
  `配置验证通过：${Object.keys(bundle.roles).length} 个角色，${Object.keys(bundle.skills).length} 个技能\n`,
);
