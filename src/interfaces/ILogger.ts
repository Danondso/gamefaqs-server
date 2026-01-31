export interface ILogger {
  log(category: string, message: string, ...args: any[]): void;
  error(category: string, message: string, ...args: any[]): void;
  warn(category: string, message: string, ...args: any[]): void;
  info(category: string, message: string, ...args: any[]): void;
  debug(category: string, message: string, ...args: any[]): void;
}
