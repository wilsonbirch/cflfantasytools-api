enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
}

const LOG_LEVEL_PRIORITY = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
}

class Logger {
    private minLogLevel: LogLevel

    constructor() {
        const envLogLevel = process.env.LOG_LEVEL as LogLevel
        this.minLogLevel = envLogLevel || LogLevel.INFO
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLogLevel]
    }

    private formatTimestamp(): string {
        const now = new Date()
        const pad = (n: number, w = 2) => String(n).padStart(w, '0')
        return (
            `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
            `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())},${pad(now.getMilliseconds(), 3)}`
        )
    }

    private formatModuleName(filename: string): string {
        return filename
            .replace(/\.[^/.]+$/, '')
            .replace(/[/\\]/g, '.')
            .replace(/^\.+|\.+$/g, '')
    }

    private log(level: LogLevel, filename: string, message?: string): void {
        if (!this.shouldLog(level)) return

        const moduleName = this.formatModuleName(filename)
        const messageText = message || 'NO MESSAGE INCLUDED'

        const line =
            process.env.NODE_ENV === 'production'
                ? `${moduleName} - ${level} - ${messageText}`
                : `${this.formatTimestamp()} - ${moduleName} - ${level} - ${messageText}`

        const write =
            level === LogLevel.ERROR || level === LogLevel.WARN ? console.error : console.log
        write(line)
    }

    info(filename: string, message?: string): void {
        this.log(LogLevel.INFO, filename, message)
    }

    error(filename: string, message?: string): void {
        this.log(LogLevel.ERROR, filename, message)
    }

    warn(filename: string, message?: string): void {
        this.log(LogLevel.WARN, filename, message)
    }

    debug(filename: string, message?: string): void {
        this.log(LogLevel.DEBUG, filename, message)
    }
}

export const logger = new Logger()
