class Address {
  host: string;

  port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  toString() {
    return `${this.host}:${this.port}`;
  }

  equals(other: Address | undefined) {
    return other?.host === this.host && other.port === this.port;
  }
}

export default Address;