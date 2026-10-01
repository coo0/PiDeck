import { atomWithStorage } from "jotai/utils";
import type { SessionModelPreference } from "../../../shared/types";
import { readWelcomeDshModelPreference, readWelcomeModelPreference, readWelcomeThinkingPreference, WELCOME_DSH_MODEL_KEY, WELCOME_MODEL_KEY, WELCOME_THINKING_KEY } from "../utils/chatSessionBootstrap";

export type WelcomeModelPreferences = { pi?: SessionModelPreference; dsh?: SessionModelPreference };

/** 模型欢迎页偏好与显示/首次创建共用；旧 key 作为迁移来源。 */
export const welcomeModelPreferenceAtom = atomWithStorage<WelcomeModelPreferences>(
	WELCOME_MODEL_KEY,
	{},
	{
		getItem: () => ({ pi: readWelcomeModelPreference()?.model, dsh: readWelcomeDshModelPreference()?.model }),
		setItem: (_key, value) => {
			try {
				if (value.pi) localStorage.setItem(WELCOME_MODEL_KEY, JSON.stringify(value.pi));
				else localStorage.removeItem(WELCOME_MODEL_KEY);
				if (value.dsh) localStorage.setItem(WELCOME_DSH_MODEL_KEY, JSON.stringify(value.dsh));
				else localStorage.removeItem(WELCOME_DSH_MODEL_KEY);
			} catch {
				// 存储不可用时保留 atom 内存值，首次创建直接读取共享 atom。
			}
		},
		removeItem: () => {
			try {
				localStorage.removeItem(WELCOME_MODEL_KEY);
				localStorage.removeItem(WELCOME_DSH_MODEL_KEY);
			} catch {
				// 存储不可用时只重置页面内偏好。
			}
		},
	},
	{ getOnInit: true },
);

// 保留原始字符串格式；首次发送直接读取同一 Jotai atom，兼容 localStorage 不可用时的内存值。
export const welcomeThinkingLevelAtom = atomWithStorage<string | undefined>(
	WELCOME_THINKING_KEY,
	undefined,
	{
		getItem: () => readWelcomeThinkingPreference()?.thinkingLevel,
		setItem: (key, level) => {
			try {
				if (level === undefined) localStorage.removeItem(key);
				else localStorage.setItem(key, level);
			} catch {
				// 存储不可用时仍保留本次页面内选择，首次创建由共享 atom 读取。
			}
		},
		removeItem: (key) => {
			try {
				localStorage.removeItem(key);
			} catch {
				// 存储不可用时只重置页面内偏好。
			}
		},
	},
	{ getOnInit: true },
);
