export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export interface LogSink {
    appendLine(message: string): void;
}

export class Logger {
    private level: LogLevel;

    constructor(
        private readonly sink: LogSink,
        level: LogLevel = 'info',
    ) {
        this.level = level;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    debug(message: string): void {
        this.write('debug', message);
    }

    info(message: string): void {
        this.write('info', message);
    }

    warn(message: string): void {
        this.write('warn', message);
    }

    error(message: string): void {
        this.write('error', message);
    }

    private write(level: LogLevel, message: string): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
            return;
        }
        const ts = new Date().toISOString();
        this.sink.appendLine(`[${ts}] [${level}] ${message}`);
    }
}
